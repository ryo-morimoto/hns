import { err } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { FileError } from "@earendil-works/pi-durable/env";
import type {
  BinaryReader,
  DirReader,
  ExecutionEnv,
  FileChange,
  FileInfo,
  FileListing,
  FileWatcher,
  ListFilesOptions,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
  WatchTarget,
} from "@earendil-works/pi-durable/env";

/**
 * An ExecutionEnv that forwards every member to another one. Subclasses
 * override what they wrap, and the compiler refuses one that forgets a member
 * added to ExecutionEnv.
 */
export class ForwardingEnv implements ExecutionEnv {
  readonly #inner: ExecutionEnv;

  constructor(inner: ExecutionEnv) {
    this.#inner = inner;
  }

  get id(): string {
    return this.#inner.id;
  }

  get cwd(): string {
    return this.#inner.cwd;
  }

  set cwd(value: string) {
    this.#inner.cwd = value;
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#inner.absolutePath(path, context);
  }

  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.#inner.joinPath(parts, context);
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#inner.readTextFile(path, context);
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.#inner.openTextLineReader(path, context);
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.#inner.readTextLines(path, options, context);
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.#inner.readBinaryFile(path, context);
  }

  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.#inner.openBinaryReader(path, options, context);
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#inner.writeFile(path, content, context);
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#inner.appendFile(path, content, context);
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.#inner.truncateFile(path, size, context);
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#inner.flushFile(path, context);
  }

  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#inner.renameFile(sourcePath, destinationPath, context);
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#inner.fileInfo(path, context);
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#inner.listDir(path, context);
  }

  listFiles(
    path: string,
    options: ListFilesOptions | undefined,
    context: Context,
  ): Promise<Result<FileListing, FileError>> {
    const inner = this.#inner;
    if (inner.listFiles === undefined)
      return Promise.resolve(err(new FileError("not_supported", "listFiles is unavailable")));
    return inner.listFiles(path, options, context);
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.#inner.openDirReader(path, context);
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.#inner.watch(targets, onChange, context);
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#inner.canonicalPath(path, context);
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.#inner.exists(path, context);
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#inner.createDir(path, options, context);
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#inner.remove(path, options, context);
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#inner.createTempDir(prefix, context);
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.#inner.createTempFile(options, context);
  }

  cleanup(context: Context): Promise<void> {
    return this.#inner.cleanup(context);
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, import("@earendil-works/pi-durable/env").ExecutionError>> {
    return this.#inner.exec(command, options, context);
  }
}
