/**
 * An in-memory stand-in for a File System Access directory handle, for tests.
 *
 * It behaves like the real thing in the ways the app relies on: a write only lands when the
 * writable is closed, a missing entry throws NotFoundError, and permission can be granted,
 * prompted for, or denied. Every change is recorded in `log` so a test can assert exactly what
 * was (or was not) written or removed.
 */

export function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

type Shared = {
  log: string[];
  /** Called before a write is started; throw from it to make that write fail. */
  beforeWrite?: (path: string) => void;
  /** Called before a write is committed; throw from it to fail a write part-way. */
  beforeClose?: (path: string) => void;
  /** Called before an entry is looked up; throw from it to make the lookup fail. */
  beforeLookup?: (path: string) => void;
};

export class MockDir {
  readonly kind = 'directory';
  readonly dirs = new Map<string, MockDir>();
  readonly files = new Map<string, Blob>();
  permission: PermissionState = 'granted';
  /** What requestPermission answers when permission is not already granted. */
  permissionAfterPrompt: PermissionState = 'granted';
  prompts = 0;

  constructor(
    readonly name = 'MySession',
    private readonly path = '',
    readonly shared: Shared = { log: [] },
  ) {}

  /** The changes made so far, e.g. "write session.json", "mkdir assets", "remove x". */
  get log(): string[] {
    return this.shared.log;
  }

  /** The handle to pass to the code under test. */
  get handle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  private at(name: string): string {
    return `${this.path}${name}`;
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDir> {
    return this.attempt(() => {
      this.shared.beforeLookup?.(this.at(name));
      let dir = this.dirs.get(name);
      if (!dir) {
        if (!options?.create) throw domError('NotFoundError');
        dir = new MockDir(name, `${this.at(name)}/`, this.shared);
        this.dirs.set(name, dir);
        this.log.push(`mkdir ${this.at(name)}`);
      }
      return dir;
    });
  }

  getFileHandle(name: string, options?: { create?: boolean }) {
    return this.attempt(() => {
      this.shared.beforeLookup?.(this.at(name));
      if (!this.files.has(name) && !options?.create) throw domError('NotFoundError');
      return {
        kind: 'file',
        name,
        getFile: () => this.attempt(() => new File([this.files.get(name) ?? ''], name)),
        createWritable: () => this.attempt(() => this.writable(name)),
      };
    });
  }

  removeEntry(name: string): Promise<void> {
    return this.attempt(() => {
      this.log.push(`remove ${this.at(name)}`);
      this.files.delete(name);
      this.dirs.delete(name);
    });
  }

  queryPermission(): Promise<PermissionState> {
    return Promise.resolve(this.permission);
  }

  requestPermission(): Promise<PermissionState> {
    this.prompts += 1;
    this.permission = this.permissionAfterPrompt;
    return Promise.resolve(this.permission);
  }

  /** Puts a file in place without logging it, to set up a test. */
  seed(name: string, content: string | Blob): this {
    this.files.set(name, typeof content === 'string' ? new Blob([content]) : content);
    return this;
  }

  /** Creates (or returns) a subfolder without logging it, to set up a test. */
  seedDir(name: string): MockDir {
    const dir = this.dirs.get(name) ?? new MockDir(name, `${this.at(name)}/`, this.shared);
    this.dirs.set(name, dir);
    return dir;
  }

  async text(name: string): Promise<string> {
    const file = this.files.get(name);
    if (!file) throw new Error(`no file ${this.at(name)}`);
    return file.text();
  }

  private writable(name: string) {
    this.shared.beforeWrite?.(this.at(name));
    let pending: Blob | null = null;
    return {
      write: (data: string | Blob) =>
        this.attempt(() => {
          pending = typeof data === 'string' ? new Blob([data]) : data;
        }),
      close: () =>
        this.attempt(() => {
          this.shared.beforeClose?.(this.at(name));
          this.files.set(name, pending ?? new Blob([]));
          this.log.push(`write ${this.at(name)}`);
        }),
      abort: () =>
        this.attempt(() => {
          pending = null;
          this.log.push(`abort ${this.at(name)}`);
        }),
    };
  }

  /** Runs `fn`, turning a thrown error into a rejected promise as the real API does. */
  private attempt<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
