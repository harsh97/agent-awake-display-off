// Minimal Node typings for the trusted worker (Orca ships no @types/node).
declare module 'node:child_process' {
  export type WritableStream = {
    destroy(): void
    on(event: 'error', listener: (error: unknown) => void): void
  }
  export type ReadableStream = {
    on(event: 'data', listener: (chunk: unknown) => void): void
  }
  export type ChildProcess = {
    stdin: WritableStream | null
    stdout: ReadableStream | null
    on(event: 'error', listener: (error: unknown) => void): void
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
    kill(): void
  }
  export function spawn(
    program: string,
    args: string[],
    options: { stdio: ('pipe' | 'ignore')[]; windowsHide?: boolean }
  ): ChildProcess
}

declare function setTimeout(handler: () => void, timeout?: number): { unref?: () => void }
declare function clearTimeout(timer: { unref?: () => void } | undefined): void
declare function setInterval(handler: () => void, timeout?: number): { unref?: () => void }
declare function clearInterval(timer: { unref?: () => void } | undefined): void

declare const process: {
  platform: string
  env: Record<string, string | undefined>
  pid: number
}
