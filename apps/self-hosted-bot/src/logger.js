const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, context = undefined) {
    if (LEVELS[levelName] < threshold) {
      return;
    }

    const entry = {
      time: new Date().toISOString(),
      level: levelName,
      message,
      ...(context ? { context } : {}),
    };

    const line = JSON.stringify(entry);
    if (levelName === 'error') {
      console.error(line);
      return;
    }

    if (levelName === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}
