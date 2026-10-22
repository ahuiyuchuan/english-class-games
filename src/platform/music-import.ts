/**
 * One renderer-wide music operation; navigation and native close share its cleanup.
 * Cancellation waits for late IPC replies before releasing the slot, so a second
 * operation cannot race an old decoder or accidentally publish its temporary WAV.
 * @author ahui
 */
import * as native from './native';

export interface MusicOperation {
  id: string;
  cancelled: boolean;
  committing: boolean;
  done: Promise<void>;
  finish: () => void;
  cancelWait?: () => void;
}
let current: MusicOperation | undefined;
let closing = false;

/** Hold admission across asynchronous save/discard guards; reopen if close is cancelled. */
export function setMusicImportsClosing(value: boolean): void {
  closing = value;
}

/** Reserve before opening the OS picker; duplicate clicks never launch another picker. */
export function beginMusicImport(): MusicOperation | undefined {
  if (current || closing) return;
  let resolve!: () => void;
  const done = new Promise<void>((complete) => {
    resolve = complete;
  });
  const operation: MusicOperation = {
    id: crypto.randomUUID(),
    cancelled: false,
    committing: false,
    done,
    finish: () => {
      if (current === operation) current = undefined;
      resolve();
    },
  };
  current = operation;
  return operation;
}

/** Short commit finishes atomically; preparation cancels and drains before close. */
export async function cancelActiveMusicImport(): Promise<void> {
  const operation = current;
  if (!operation) return;
  if (!operation.committing) {
    operation.cancelled = true;
    operation.cancelWait?.();
    await native.cancelMusic(operation.id);
  }
  await operation.done;
}
