// Thin typed bridge over the global Tauri IPC (withGlobalTauri: true),
// so we don't need the @tauri-apps/api npm package.

declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke<T = unknown>(
          cmd: string,
          args?: unknown,
          options?: { headers?: Record<string, string> },
        ): Promise<T>;
      };
    };
  }
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI__.core.invoke<T>(cmd, args);
}

/** Invoke a command whose payload is raw bytes (Rust side reads InvokeBody::Raw). */
export function invokeBinary<T>(
  cmd: string,
  body: Uint8Array | ArrayBuffer,
  headers: Record<string, string> = {},
): Promise<T> {
  return window.__TAURI__.core.invoke<T>(cmd, body, { headers });
}
