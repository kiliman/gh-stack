// gh-stack untrack — Remove a branch from its stack's metadata only. The local
// branch, origin's copy and the PR stay. `delete --keep-branch` did the same,
// but the command's name kept sessions away from it (#82).
import deleteCmd from "./delete.ts";

export default async function untrackCmd(args: string[]): Promise<void> {
  await deleteCmd(args, { untrack: true });
}
