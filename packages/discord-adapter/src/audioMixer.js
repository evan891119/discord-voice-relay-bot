import { Readable } from 'node:stream';
import prism from 'prism-media';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SIZE = 960;
const BYTES_PER_SAMPLE = 2;
const FRAME_DURATION_MS = 20;
const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE;
const SOURCE_INACTIVITY_MS = 500;
const MIX_IDLE_MS = 600;
const MAX_SOURCE_BUFFER_FRAMES = 25;

function createSilenceFrame() {
  return Buffer.alloc(PCM_FRAME_BYTES);
}

function clampInt16(value) {
  if (value > 32_767) {
    return 32_767;
  }

  if (value < -32_768) {
    return -32_768;
  }

  return value;
}

function splitPcmFrames(chunk) {
  const frames = [];
  for (let offset = 0; offset + PCM_FRAME_BYTES <= chunk.length; offset += PCM_FRAME_BYTES) {
    frames.push(chunk.subarray(offset, offset + PCM_FRAME_BYTES));
  }
  return frames;
}

class PcmMixStream extends Readable {
  constructor({ direction, logger }) {
    super();
    this.direction = direction;
    this.logger = logger;
    this.sources = new Map();
    this.silence = createSilenceFrame();
    this.interval = undefined;
    this.idleSince = Date.now();
    this.startedAt = Date.now();
    this.ended = false;
  }

  _read() {}

  start() {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.mixFrame();
    }, FRAME_DURATION_MS);
  }

  addSource(userId, opusStream) {
    if (this.ended) {
      opusStream.destroy();
      return false;
    }

    if (this.sources.has(userId)) {
      return true;
    }

    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: FRAME_SIZE,
    });

    const source = {
      decoder,
      ended: false,
      frames: [],
      opusStream,
      userId,
    };

    this.sources.set(userId, source);

    decoder.on('data', (chunk) => {
      source.frames.push(...splitPcmFrames(chunk));

      if (source.frames.length > MAX_SOURCE_BUFFER_FRAMES) {
        const dropped = source.frames.length - MAX_SOURCE_BUFFER_FRAMES;
        source.frames.splice(0, dropped);
        this.logger.warn('dropping buffered pcm frames', {
          direction: this.direction,
          dropped,
          userId,
        });
      }
    });

    decoder.once('error', (error) => {
      this.logger.error('opus decoder error', {
        direction: this.direction,
        error: error.message,
        userId,
      });
      this.removeSource(userId);
    });

    opusStream.once('end', () => {
      source.ended = true;
      this.logger.info('speaker opus stream ended', {
        direction: this.direction,
        userId,
      });
    });

    opusStream.once('close', () => {
      source.ended = true;
    });

    opusStream.once('error', (error) => {
      source.ended = true;
      this.logger.error('speaker opus stream error', {
        direction: this.direction,
        error: error.message,
        userId,
      });
    });

    opusStream.pipe(decoder);
    this.logger.info('speaker added to mixer', {
      direction: this.direction,
      sourceCount: this.sources.size,
      userId,
    });

    return true;
  }

  removeSource(userId) {
    const source = this.sources.get(userId);
    if (!source) {
      return;
    }

    source.opusStream.destroy();
    source.decoder.destroy();
    this.sources.delete(userId);
    this.logger.info('speaker removed from mixer', {
      direction: this.direction,
      sourceCount: this.sources.size,
      userId,
    });
  }

  mixFrame() {
    if (this.ended) {
      return;
    }

    const activeFrames = [];
    for (const [userId, source] of this.sources.entries()) {
      const frame = source.frames.shift();
      if (frame) {
        activeFrames.push(frame);
        continue;
      }

      if (source.ended) {
        this.removeSource(userId);
      }
    }

    if (activeFrames.length === 0) {
      if (this.sources.size === 0) {
        if (Date.now() - this.idleSince >= MIX_IDLE_MS) {
          this.stop();
          return;
        }
      }

      this.push(this.silence);
      return;
    }

    this.idleSince = Date.now();
    this.push(this.mixPcmFrames(activeFrames));
  }

  mixPcmFrames(frames) {
    if (frames.length === 1) {
      return frames[0];
    }

    const mixed = Buffer.alloc(PCM_FRAME_BYTES);
    const gain = 1 / Math.sqrt(frames.length);

    for (let offset = 0; offset < PCM_FRAME_BYTES; offset += BYTES_PER_SAMPLE) {
      let sample = 0;
      for (const frame of frames) {
        sample += frame.readInt16LE(offset);
      }

      mixed.writeInt16LE(clampInt16(Math.round(sample * gain)), offset);
    }

    return mixed;
  }

  stop() {
    if (this.ended) {
      return;
    }

    this.ended = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    for (const userId of [...this.sources.keys()]) {
      this.removeSource(userId);
    }

    this.push(null);
    this.logger.info('mixer stopped', {
      direction: this.direction,
      durationMs: Date.now() - this.startedAt,
    });
  }

  _destroy(error, callback) {
    this.stop();
    callback(error);
  }
}

export function createMixSession({ direction, logger }) {
  const pcmStream = new PcmMixStream({ direction, logger });
  const encoder = new prism.opus.Encoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: FRAME_SIZE,
  });

  encoder.once('error', (error) => {
    logger.error('opus encoder error', {
      direction,
      error: error.message,
    });
    pcmStream.destroy(error);
  });

  pcmStream.pipe(encoder);
  pcmStream.start();

  return {
    addSource: (userId, opusStream) => pcmStream.addSource(userId, opusStream),
    destroy: () => pcmStream.destroy(),
    hasSource: (userId) => pcmStream.sources.has(userId),
    opusStream: encoder,
    sourceCount: () => pcmStream.sources.size,
  };
}

export const MIXER_LIMITS = {
  channels: CHANNELS,
  frameDurationMs: FRAME_DURATION_MS,
  frameSize: FRAME_SIZE,
  maxSourceBufferFrames: MAX_SOURCE_BUFFER_FRAMES,
  mixIdleMs: MIX_IDLE_MS,
  sampleRate: SAMPLE_RATE,
  sourceInactivityMs: SOURCE_INACTIVITY_MS,
};
