/**
 * Serializes KnowFlow mutations for the same note while allowing different
 * notes to be processed concurrently.
 */
export class NoteOperationCoordinator {
  private tails = new Map<string, Promise<void>>();

  async runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(path, tail);

    try {
      return await task;
    } finally {
      if (this.tails.get(path) === tail) {
        this.tails.delete(path);
      }
    }
  }
}
