// The "+" next to a loop's Input path: the native folder picker, then the picked folder as an input path. Shared by the
// Loop page and the loop Boards so both fields accept the same folders.
import { invokeHost } from "../../shell/host";
import { decodePickedChoice, decodePickedFolder } from "../../shell/host-prefs";
import { inputPathFromPicked } from "./input-path.ts";

/** `null` when the picker was cancelled. `root` is the repository the loop works on (its work root). */
export async function pickInputPath(root: string, title = "Choose the folder to work on"): Promise<{ path: string } | { error: string } | null> {
  try {
    const choice = decodePickedChoice(await invokeHost<unknown>("pick_folder", { title }));
    if (!choice) return null;
    const picked = decodePickedFolder(await invokeHost<unknown>("pick_folder_redeem", { token: choice.token }));
    if (!picked) return { error: "The desktop host returned a folder this app cannot use." };
    return inputPathFromPicked(picked, root);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
