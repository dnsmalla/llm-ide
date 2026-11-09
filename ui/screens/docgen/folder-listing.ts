// The signal for the pages of one folder listing. Opening another folder aborts the pages still in flight for the
// old one, so a late "Load more" answer cannot append rows from the old folder to the new one.

export class FolderListing {
  private ctl = new AbortController();

  /** The signal for requests about the current folder. */
  get signal(): AbortSignal {
    return this.ctl.signal;
  }

  /** Leaves the current folder (aborting its pending pages) and returns the signal for the new one. */
  switchTo(): AbortSignal {
    this.ctl.abort();
    this.ctl = new AbortController();
    return this.ctl.signal;
  }

  /** Stops everything in flight, for unmount. */
  dispose(): void {
    this.ctl.abort();
  }
}
