import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Doc Gen files" group. The Mac offers a beta switch between the server and the folder on disk.
 * The desktop has only one path: every Doc Gen template and command operation goes through the core's docs
 * routes, which read and write the project's templates/ and commands/ folders. Showing a switch with one
 * state would be a control that does nothing, so this card explains that instead.
 */
export default function DocGenFilesSection() {
  return (
    <div className="st-stack">
      <p>
        Doc Gen templates and commands are project files. On the Mac a beta switch chooses whether they are listed,
        saved and deleted through the server or from the folder on disk.
      </p>
      <p className="st-hint">
        On the desktop there is no separate local mode: every Doc Gen file operation goes through the core&apos;s docs
        routes (`/kb/projects/register`, `/kb/docs/templates`, `/kb/docs/commands`), which read and write the
        project&apos;s `templates/` and `commands/` folders. The switch would have only one state here.
      </p>
      <PartialNote id="doc-gen" />
    </div>
  );
}
