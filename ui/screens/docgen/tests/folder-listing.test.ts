import { test } from "node:test";
import assert from "node:assert/strict";
import { FolderListing } from "../folder-listing.ts";

test("M3: a page requested for the old folder is aborted when the folder changes", () => {
  const listing = new FolderListing();
  const first = listing.signal;
  assert.equal(first.aborted, false);
  const second = listing.switchTo();
  assert.equal(first.aborted, true, "the old folder's pending pages are cancelled");
  assert.equal(second.aborted, false);
  assert.equal(listing.signal, second, "Load more uses the current folder's signal");
  listing.dispose();
  assert.equal(second.aborted, true, "unmount cancels the current folder too");
});
