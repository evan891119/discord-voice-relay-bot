function nowIso() {
  return new Date().toISOString();
}

function assertBridgeDefinition(bridge) {
  if (!bridge) {
    throw new Error('Bridge definition was not found');
  }

  if (!bridge.enabled) {
    throw new Error(`Bridge ${bridge.id} is disabled`);
  }

  if (!Array.isArray(bridge.endpoints)) {
    throw new Error(`Bridge ${bridge.id} must define endpoints`);
  }

  const mode = bridge.mode ?? 'pair';
  if (mode === 'pair' && bridge.endpoints.length !== 2) {
    throw new Error(`Bridge ${bridge.id} must have exactly two endpoints`);
  }

  if (mode === 'group') {
    if (bridge.endpoints.length < 2) {
      throw new Error(`Group bridge ${bridge.id} must have at least two endpoints`);
    }

    if (bridge.maxEndpoints && bridge.endpoints.length > bridge.maxEndpoints) {
      throw new Error(`Group bridge ${bridge.id} exceeds maxEndpoints`);
    }
  }

  if (mode !== 'pair' && mode !== 'group') {
    throw new Error(`Bridge ${bridge.id} has unsupported mode: ${mode}`);
  }

  const endpointIds = new Set();
  const endpointKeys = new Set();
  const discordGuildIds = new Set();
  for (const endpoint of bridge.endpoints) {
    if (endpointIds.has(endpoint.id)) {
      throw new Error(`Bridge ${bridge.id} contains duplicate endpoint id ${endpoint.id}`);
    }
    endpointIds.add(endpoint.id);

    const key = `${endpoint.kind}:${endpoint.guildId}:${endpoint.voiceChannelId}`;
    if (endpointKeys.has(key)) {
      throw new Error(`Bridge ${bridge.id} contains duplicate endpoint ${key}`);
    }
    endpointKeys.add(key);

    if (endpoint.kind === 'discord') {
      if (discordGuildIds.has(endpoint.guildId)) {
        throw new Error(`Bridge ${bridge.id} contains multiple Discord endpoints in guild ${endpoint.guildId}`);
      }
      discordGuildIds.add(endpoint.guildId);
    }
  }
}

function stateFor(bridgeId, status, reason = undefined) {
  return {
    bridgeId,
    status,
    ...(reason ? { reason } : {}),
    updatedAt: nowIso(),
  };
}

function isExpiredPairingCode(record) {
  if (!record?.expiresAt) {
    return false;
  }

  return Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) <= Date.now();
}

function systemContext() {
  return {
    system: true,
    subject: {
      userId: 'system',
      guildId: 'system',
      roleIds: [],
    },
  };
}

async function saveState(stateStore, state) {
  await stateStore?.saveBridgeState?.(state);
  return state;
}

async function requirePermission(permissionPolicy, action, context, bridge) {
  if (!permissionPolicy) {
    return;
  }

  const decision = await permissionPolicy.can(action, context, bridge);
  if (decision?.allowed) {
    return;
  }

  const reason = decision?.reason ? ` (${decision.reason})` : '';
  throw new Error(decision?.message ?? `Permission denied for ${action}${reason}`);
}

export function createMemoryStateStore() {
  const bridgeStates = new Map();
  const pairingCodes = new Map();

  return {
    async getBridgeState(bridgeId) {
      return bridgeStates.get(bridgeId);
    },
    async saveBridgeState(state) {
      bridgeStates.set(state.bridgeId, state);
    },
    async savePairingCode(record) {
      pairingCodes.set(record.code, record);
    },
    async getPairingCode(code) {
      const record = pairingCodes.get(code);
      if (isExpiredPairingCode(record)) {
        pairingCodes.delete(code);
        return undefined;
      }

      return record;
    },
    async listPairingCodes() {
      return [...pairingCodes.values()].filter((record) => !isExpiredPairingCode(record));
    },
    async deletePairingCode(code) {
      pairingCodes.delete(code);
    },
    async consumePairingCode(code) {
      const record = pairingCodes.get(code);
      pairingCodes.delete(code);
      if (isExpiredPairingCode(record)) {
        return undefined;
      }

      return record;
    },
  };
}

/**
 * Create the shared bridge lifecycle engine.
 *
 * The engine owns bridge start/stop orchestration and state transitions. It
 * receives Discord-specific operations from the app shell so this package does
 * not import discord.js, @discordjs/voice, dotenv, local config files,
 * dashboard code, or billing code.
 *
 * @param {object} dependencies
 * @param {import('./contracts.js').ConfigProvider} dependencies.configProvider
 * @param {import('./contracts.js').PermissionPolicy} [dependencies.permissionPolicy]
 * @param {import('./contracts.js').StateStore} [dependencies.stateStore]
 * @param {(endpoint: import('./contracts.js').BridgeEndpoint) => Promise<object>} dependencies.joinEndpoint
 * @param {(endpointA: import('./contracts.js').BridgeEndpoint, sessionA: object, endpointB: import('./contracts.js').BridgeEndpoint, sessionB: object) => object} dependencies.startTwoWayForwarding
 * @param {(options: { bridgeId: string, endpoints: import('./contracts.js').BridgeEndpoint[], sessions: object[] }) => object} [dependencies.startGroupForwarding]
 * @param {(endpoint: import('./contracts.js').BridgeEndpoint, session: object) => object} [dependencies.startRecovery]
 * @param {(options: { bridgeId: string, endpointRecoveries: Array<{ endpoint: import('./contracts.js').BridgeEndpoint, recovery: object }>, onEndpointEmpty?: Function }) => object} [dependencies.startVoiceStateMonitor]
 * @param {(event: { bridge: import('./contracts.js').BridgeDefinition, endpoint: import('./contracts.js').BridgeEndpoint, reason: string }) => Promise<void>} [dependencies.onEndpointEmpty]
 * @param {(endpoint: import('./contracts.js').BridgeEndpoint, session: object) => Promise<void> | void} [dependencies.disconnectEndpoint]
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [dependencies.logger]
 * @returns {import('./contracts.js').BridgeEngine}
 */
export function createBridgeEngine({
  configProvider,
  permissionPolicy = undefined,
  stateStore = createMemoryStateStore(),
  joinEndpoint,
  startTwoWayForwarding,
  startGroupForwarding = undefined,
  startRecovery = undefined,
  startVoiceStateMonitor = undefined,
  onEndpointEmpty = undefined,
  disconnectEndpoint = undefined,
  logger = console,
}) {
  const activeBridges = new Map();

  async function startBridge(bridgeId, context = systemContext()) {
    if (activeBridges.has(bridgeId)) {
      const existingState = await stateStore.getBridgeState(bridgeId);
      return existingState ?? saveState(stateStore, stateFor(bridgeId, 'running'));
    }

    const bridge = await configProvider.getBridge(bridgeId);
    assertBridgeDefinition(bridge);
    if (bridge.endpoints.length > 2 && !startGroupForwarding) {
      throw new Error(`Bridge ${bridge.id} needs group forwarding for more than two endpoints`);
    }
    await requirePermission(permissionPolicy, 'start_bridge', context, bridge);
    await saveState(stateStore, stateFor(bridge.id, 'starting'));
    let sessions = [];

    logger.info?.('bridge engine starting bridge', {
      bridgeId: bridge.id,
      bridgeMode: bridge.mode ?? 'pair',
      bridgeName: bridge.name,
      endpoints: bridge.endpoints.map((endpoint) => ({
        id: endpoint.id,
        kind: endpoint.kind,
        guildId: endpoint.guildId,
        voiceChannelId: endpoint.voiceChannelId,
      })),
    });

    try {
      sessions = await Promise.all(bridge.endpoints.map((endpoint) => joinEndpoint(endpoint)));
      const endpointRecoveries = bridge.endpoints.map((endpoint, index) => ({
        endpoint,
        recovery: startRecovery?.(endpoint, sessions[index]),
      }));

      const voiceStateMonitor = startVoiceStateMonitor?.({
        bridgeId: bridge.id,
        endpointRecoveries,
        onEndpointEmpty: async (endpoint, reason) => {
          if (onEndpointEmpty) {
            await onEndpointEmpty({ bridge, endpoint, reason });
            return;
          }

          await stopBridge(bridge.id);
        },
      });
      const forwarder = startGroupForwarding
        ? startGroupForwarding({
          bridgeId: bridge.id,
          endpoints: bridge.endpoints,
          sessions,
        })
        : startTwoWayForwarding(bridge.endpoints[0], sessions[0], bridge.endpoints[1], sessions[1]);

      activeBridges.set(bridge.id, {
        bridge,
        endpoints: bridge.endpoints,
        forwarder,
        recoveries: endpointRecoveries.map(({ recovery }) => recovery).filter(Boolean),
        sessions,
        voiceStateMonitor,
      });

      logger.info?.('bridge engine bridge running', {
        bridgeId: bridge.id,
        bridgeMode: bridge.mode ?? 'pair',
        bridgeName: bridge.name,
        endpointCount: bridge.endpoints.length,
      });

      return saveState(stateStore, stateFor(bridge.id, 'running'));
    } catch (error) {
      for (const [index, session] of sessions.entries()) {
        const endpoint = bridge.endpoints[index];
        try {
          if (disconnectEndpoint) {
            await disconnectEndpoint(endpoint, session);
          } else {
            await session.disconnect?.();
            session.destroy?.();
          }
        } catch (disconnectError) {
          logger.warn?.('bridge engine failed to clean up endpoint after startup failure', {
            bridgeId: bridge.id,
            endpointId: endpoint?.id,
            error: disconnectError.message,
          });
        }
      }

      await saveState(stateStore, stateFor(bridge.id, 'failed', error.message));
      throw error;
    }
  }

  async function stopBridge(bridgeId, context = systemContext()) {
    const active = activeBridges.get(bridgeId);
    const bridge = active?.bridge ?? await configProvider.getBridge(bridgeId);
    if (bridge) {
      await requirePermission(permissionPolicy, 'stop_bridge', context, bridge);
    }

    if (!active) {
      return saveState(stateStore, stateFor(bridgeId, 'stopped'));
    }

    await saveState(stateStore, stateFor(bridgeId, 'stopping'));
    logger.info?.('bridge engine stopping bridge', {
      bridgeId,
      bridgeName: active.bridge.name,
    });

    active.voiceStateMonitor?.destroy?.();
    for (const recovery of active.recoveries) {
      recovery.destroy?.();
    }
    active.forwarder?.destroy?.();

    for (const [index, session] of active.sessions.entries()) {
      const endpoint = active.endpoints[index];
      if (disconnectEndpoint) {
        await disconnectEndpoint(endpoint, session);
        continue;
      }

      await session.disconnect?.();
      session.destroy?.();
    }

    activeBridges.delete(bridgeId);
    logger.info?.('bridge engine bridge stopped', {
      bridgeId,
      bridgeName: active.bridge.name,
    });

    return saveState(stateStore, stateFor(bridgeId, 'stopped'));
  }

  async function getBridgeState(bridgeId) {
    return stateStore.getBridgeState(bridgeId);
  }

  return {
    getBridgeState,
    startBridge,
    stopBridge,
  };
}
