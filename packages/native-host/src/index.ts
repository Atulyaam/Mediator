/**
 * @mediator/native-host
 *
 * Chromium Native Messaging Host for Windows (S19).
 */

export * from './framing.js';
export * from './originValidator.js';
export * from './registration.js';
export * from './nativeHostController.js';

import { NativeHostController } from './nativeHostController.js';
import { NativeMessageReader, NativeMessageWriter, logSanitizedStderr } from './framing.js';
import { DEFAULT_NAMED_PIPE_PREFIX } from '@mediator/ipc-core';

/**
 * Main execution entry point when run directly by Chromium/Node.
 */
export function runNativeHost(args: string[] = process.argv): void {
  // In Node SEA: argv[0] is exe, argv[1] is the first argument (e.g. chrome-extension://<id>/)
  // In node script: argv[0] is node, argv[1] is script.js, argv[2] is origin
  let originArg: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg && (arg.startsWith('chrome-extension://') || /^[a-p0-9]{32}$/i.test(arg))) {
      originArg = arg;
      break;
    }
  }
  if (!originArg) {
    originArg = args[1] ?? args[2];
  }

  const allowedIds = process.env.MEDIATOR_ALLOWED_EXTENSION_IDS
    ? process.env.MEDIATOR_ALLOWED_EXTENSION_IDS.split(',').map((s) => s.trim())
    : ['abcdefghijklmnopponmlkjihgfedcba', 'mediatorextensionid000000000000']; // default allowed for dev/testing

  const pipePath = process.env.MEDIATOR_IPC_PIPE ?? `${DEFAULT_NAMED_PIPE_PREFIX}core-default`;

  const reader = new NativeMessageReader();
  const writer = new NativeMessageWriter(process.stdout);

  const controller = new NativeHostController(
    {
      allowedExtensionIds: allowedIds,
      pipePath,
      defaultPairingToken: process.env.MEDIATOR_PAIRING_TOKEN,
    },
    reader,
    writer,
  );

  if (originArg) {
    controller.initializeOrigin(originArg);
  }

  process.stdin.on('data', (chunk) => {
    reader.pushChunk(chunk);
  });

  process.stdin.on('end', () => {
    logSanitizedStderr('stdin ended, exiting native host');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logSanitizedStderr('SIGTERM received, exiting');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logSanitizedStderr('SIGINT received, exiting');
    process.exit(0);
  });
}

// Auto-run if executed as script entry or packaged binary
if (typeof process !== 'undefined' && process.argv && !process.env.VITEST) {
  const arg0 = (process.argv[0] ?? '').replace(/\\/g, '/');
  const arg1 = (process.argv[1] ?? '').replace(/\\/g, '/');
  if (
    arg0.endsWith('mediator-native-host.exe') ||
    arg1.endsWith('/native-host/src/index.ts') ||
    arg1.endsWith('/native-host/dist/index.js') ||
    arg1.endsWith('nativeHost.cjs') ||
    arg1.startsWith('chrome-extension://')
  ) {
    runNativeHost();
  }
}
