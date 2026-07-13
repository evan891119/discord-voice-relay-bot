import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_FILE = new URL('../../../.local/state.json', import.meta.url);

function emptyState() {
  return {
    bridgeStates: {},
    pairingCodes: {},
  };
}

function normalizeState(raw) {
  return {
    bridgeStates: raw?.bridgeStates && typeof raw.bridgeStates === 'object'
      ? raw.bridgeStates
      : {},
    pairingCodes: raw?.pairingCodes && typeof raw.pairingCodes === 'object'
      ? raw.pairingCodes
      : {},
  };
}

function isExpired(record) {
  if (!record?.expiresAt) {
    return false;
  }

  return Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) <= Date.now();
}

export function createLocalStateStore({
  stateFile = DEFAULT_STATE_FILE,
} = {}) {
  const filePath = typeof stateFile === 'string'
    ? stateFile
    : fileURLToPath(stateFile);
  let writeQueue = Promise.resolve();

  async function readState() {
    try {
      const contents = await readFile(filePath, 'utf8');
      return normalizeState(JSON.parse(contents));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return emptyState();
      }

      throw error;
    }
  }

  async function writeState(state) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
    await rename(tempPath, filePath);
  }

  async function updateState(updater) {
    const nextWrite = writeQueue.then(async () => {
      const state = await readState();
      const result = await updater(state);
      await writeState(state);
      return result;
    });

    writeQueue = nextWrite.catch(() => {});
    return nextWrite;
  }

  return {
    async getBridgeState(bridgeId) {
      const state = await readState();
      return state.bridgeStates[bridgeId];
    },
    async saveBridgeState(bridgeState) {
      await updateState((state) => {
        state.bridgeStates[bridgeState.bridgeId] = bridgeState;
      });
    },
    async savePairingCode(record) {
      await updateState((state) => {
        state.pairingCodes[record.code] = record;
      });
    },
    async getPairingCode(code) {
      return updateState((state) => {
        const record = state.pairingCodes[code];
        if (isExpired(record)) {
          delete state.pairingCodes[code];
          return undefined;
        }

        return record;
      });
    },
    async listPairingCodes() {
      const state = await readState();
      return Object.values(state.pairingCodes).filter((record) => !isExpired(record));
    },
    async deletePairingCode(code) {
      await updateState((state) => {
        delete state.pairingCodes[code];
      });
    },
    async consumePairingCode(code) {
      return updateState((state) => {
        const record = state.pairingCodes[code];
        delete state.pairingCodes[code];

        if (isExpired(record)) {
          return undefined;
        }

        return record;
      });
    },
  };
}

export const STATE_STORE_LOCAL_PACKAGE = '@discord-voice-relay-bot/state-store-local';
