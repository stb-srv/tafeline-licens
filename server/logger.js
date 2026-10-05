import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development' || process.env.DEV_MODE === 'true';

const logger = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    base: { pid: process.pid, app: 'Tafeline License Server' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: ['body.password', 'body.password_hash', 'req.headers["authorization"]'],
        censor: '[REDACTED]',
    },
});

export default logger;
