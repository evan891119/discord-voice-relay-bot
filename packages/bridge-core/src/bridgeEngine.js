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

  if (!Array.isArray(bridge.endpoints) || bridge.endpoints.length !== 2) {
    throw new Error(`Bridge ${bridge.id} must have exactly two endpoints`);
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
    async listPairingCodes() {
      return [...pairingCodes.values()];
    },
    async consumePairingCode(code) {
      const record = pairingCodes.get(code);
      pairingCodes.delete(code);
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
 * @param {(endpoint: import('./contracts.js').BridgeEndpoint, session: object) => object} [dependencies.startRecovery]
 * @param {(options: { bridgeId: string, endpointRecoveries: Array<{ endpoint: import('./contracts.js').BridgeEndpoint, recovery: object }>, onEndpointEmpty?: Function }) => object} [dependencies.startVoiceStateMonitor]
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
  startRecovery = undefined,
  startVoiceStateMonitor = undefined,
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
    await requirePermission(permissionPolicy, 'start_bridge', context, bridge);
    await saveState(stateStore, stateFor(bridge.id, 'starting'));

    const [endpointA, endpointB] = bridge.endpoints;

    logger.info?.('bridge engine starting bridge', {
      bridgeId: bridge.id,
      bridgeName: bridge.name,
      endpoints: bridge.endpoints.map((endpoint) => ({
        id: endpoint.id,
        kind: endpoint.kind,
        guildId: endpoint.guildId,
        voiceChannelId: endpoint.voiceChannelId,
      })),
    });

    try {
      const [sessionA, sessionB] = await Promise.all([
        joinEndpoint(endpointA),
        joinEndpoint(endpointB),
      ]);

      const recoveryA = startRecovery?.(endpointA, sessionA);
      const recoveryB = startRecovery?.(endpointB, sessionB);
      const voiceStateMonitor = startVoiceStateMonitor?.({
        bridgeId: bridge.id,
        endpointRecoveries: [
          { endpoint: endpointA, recovery: recoveryA },
          { endpoint: endpointB, recovery: recoveryB },
        ],
        onEndpointEmpty: async () => {
          await stopBridge(bridge.id);
        },
      });
      const forwarder = startTwoWayForwarding(endpointA, sessionA, endpointB, sessionB);

      activeBridges.set(bridge.id, {
        bridge,
        endpoints: [endpointA, endpointB],
        forwarder,
        recoveries: [recoveryA, recoveryB].filter(Boolean),
        sessions: [sessionA, sessionB],
        voiceStateMonitor,
      });

      logger.info?.('bridge engine bridge running', {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
      });

      return saveState(stateStore, stateFor(bridge.id, 'running'));
    } catch (error) {
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
