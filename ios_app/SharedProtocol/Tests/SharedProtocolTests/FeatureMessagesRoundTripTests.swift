import XCTest
@testable import SharedProtocol

/// Round-trip (encode, decode, equal) and wire-tag checks for the feature message files that had no tests:
/// Activity, AutoTask, AutoTaskSetup, ExploreSkill, ExploreWorkspace, Explorer, Files, Issues, MacStatus,
/// Project, SelfHeal, SourceControl, ToolApproval, Usage (LlmIdeChat lives in ConnectionMessagesTests).
final class FeatureMessagesRoundTripTests: XCTestCase {
    private func rt<T: Codable & Equatable>(_ value: T, tag: String? = nil, file: StaticString = #filePath,
                                             line: UInt = #line) throws {
        let data = try JSONEncoder().encode(value)
        let back = try JSONDecoder().decode(T.self, from: data)
        XCTAssertEqual(back, value, file: file, line: line)
        if let tag {
            let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
            XCTAssertEqual(obj["type"] as? String, tag, file: file, line: line)
            XCTAssertTrue(MobileProtocol.Tag.all.contains(tag), "\(tag) missing from Tag.all", file: file, line: line)
        }
    }

    func testActivity() throws {
        try rt(ActivityList(), tag: "activity_list")
        try rt(ActivityMarkSeen(), tag: "activity_mark_seen")
        try rt(ActivityState(entries: [ActivityEntry(id: 3, kind: "task", title: "Done", createdAt: 12.5)], unread: 1),
               tag: "activity_state")
    }

    func testAutoTask() throws {
        try rt(AutoTaskList(), tag: "auto_task_list")
        try rt(AutoTaskStop(), tag: "auto_task_stop")
        try rt(AutoTaskRun(task: "reviewCode"), tag: "auto_task_run")
        try rt(AutoTaskRun(task: nil), tag: "auto_task_run")
        try rt(AutoTaskToggle(task: nil, enabled: true), tag: "auto_task_toggle")
        try rt(AutoTaskHistoryList(), tag: "auto_task_history")
        try rt(AutoTaskLogsList(), tag: "auto_task_logs_list")
        try rt(AutoTaskAck(ok: false, message: "off", code: "task_disabled"), tag: "auto_task_ack")
        try rt(AutoTaskState(masterEnabled: true, isRunning: false, currentTask: nil, currentStep: "x",
                             statusMessage: nil, lastRunDate: 5, createdCount: 1, implementedCount: 2,
                             failedCount: 3, tasks: [AutoTaskInfo(id: "a", label: "A", enabled: true, lastError: nil)]),
               tag: "auto_task_state")
        try rt(AutoTaskHistoryReply(entries: [AutoTaskHistoryEntry(actionText: "t", status: "done", lastUpdated: 1)]),
               tag: "auto_task_history_reply")
        try rt(AutoTaskLogsReply(currentTask: "a", tasks: [
            AutoTaskTaskLogs(id: "a", label: "A", lines: [AutoTaskLogLine(id: "1", timestamp: 2, level: "info", text: "hi")])
        ]), tag: "auto_task_logs_reply")
    }

    /// The `code` field is additive: an older Mac's ack without it still decodes, and the code survives otherwise.
    func testAckAndErrorCodeAreAdditive() throws {
        let old = Data(#"{"type":"auto_task_ack","ok":false,"message":"x"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(AutoTaskAck.self, from: old).code)
        let oldErr = Data(#"{"type":"error","commandId":"c","message":"m"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(CommandError.self, from: oldErr).code)
        try rt(CommandError(commandId: "c", message: "m", code: "desktop_only"), tag: "error")
    }

    func testAutoTaskSetup() throws {
        try rt(AutoTaskSetupList(), tag: "auto_task_setup_list")
        try rt(AutoTaskConfigSet(taskId: "a", inputPath: "in", outputPath: nil, skillName: "s", templateId: "t"),
               tag: "auto_task_config_set")
        try rt(AutoTaskTemplateSave(id: nil, name: "n", body: "b"), tag: "auto_task_template_save")
        try rt(AutoTaskTemplateRename(id: "i", name: "n"), tag: "auto_task_template_rename")
        try rt(AutoTaskTemplateDelete(id: "i"), tag: "auto_task_template_delete")
        try rt(AutoTaskSetupReply(
            hasProject: true, projectName: "P",
            templates: [AutoTaskTemplateInfo(id: "t", name: "N", body: "B")],
            configs: [AutoTaskConfigInfo(taskId: "a", inputPath: nil, outputPath: "o", skillName: nil, templateId: nil)],
            skills: [AutoTaskSkillInfo(name: "s", description: "d")], folders: ["docs"]),
               tag: "auto_task_setup_reply")
    }

    func testExploreSkillsAndWorkspace() throws {
        try rt(ExploreSearchSkills(query: "q", limit: 10), tag: "explore_search_skills")
        try rt(ExploreSkillListReply(matches: [ExploreSkillEntry(id: "i", name: "n", description: "d", kind: "skill",
                                                                 directive: nil)], error: nil),
               tag: "explore_skill_list_reply")
        try rt(ExploreSkillRef(id: "i", name: "n", kind: "skill", directive: "do"))
        try rt(ExploreSearchFiles(query: "q", limit: 5), tag: "explore_search_files")
        try rt(ExploreSearchReply(workspaceRoot: "/w", matches: [ExploreWorkspaceEntry(path: "a", name: "a", isDirectory: false)],
                                  error: nil), tag: "explore_search_reply")
        try rt(ExploreWorkspaceRef(path: "a", kind: "file"))
    }

    func testExplorerSessions() throws {
        try rt(ExploreListSessions(), tag: "explore_list_sessions")
        try rt(ExploreNewSession(), tag: "explore_new_session")
        try rt(ExploreSessionList(sessions: [ExploreSessionSummary(id: "s", title: "T", lastUsedAt: 4)]),
               tag: "explore_session_list")
        try rt(ExploreLoadSession(sessionId: "s"), tag: "explore_load_session")
        try rt(ExploreSessionCreated(sessionId: "s"), tag: "explore_session_created")
        try rt(ExploreDeleteSession(sessionId: "s"), tag: "explore_delete_session")
        try rt(ExploreChat(sessionId: "s", commandId: "c", text: "hi",
                           files: [ChatFileText(name: "n", text: "t")],
                           refs: [ExploreWorkspaceRef(path: "a", kind: "file")],
                           skills: [ExploreSkillRef(id: "i", name: "n", kind: "skill", directive: nil)]),
               tag: "explore_chat")
        // A phone that sends only the required keys still decodes.
        let minimal = Data(#"{"type":"explore_chat","sessionId":"s","commandId":"c","text":"t"}"#.utf8)
        let decoded = try JSONDecoder().decode(ExploreChat.self, from: minimal)
        XCTAssertTrue(decoded.files.isEmpty && decoded.refs.isEmpty && decoded.skills.isEmpty)
    }

    func testFiles() throws {
        try rt(FilesList(path: "a"), tag: "files_list")
        try rt(FilesRead(path: "a/b"), tag: "files_read")
        try rt(FilesListing(path: "a", entries: [FileEntry(name: "x", isDirectory: true, size: 0)], truncated: true),
               tag: "files_listing")
        try rt(FilesFile(path: "a", text: "t", truncated: false, error: nil), tag: "files_file")
    }

    func testIssues() throws {
        let summary = IssueSummary(number: 7, title: "T", state: "opened", labels: ["bug"], assignee: nil,
                                   commentCount: 2, updatedAt: "2026-01-01T00:00:00Z")
        try rt(IssuesList(state: "opened"), tag: "issues_list")
        try rt(IssueGet(number: 7), tag: "issue_get")
        try rt(IssueCommentPost(number: 7, body: "hi"), tag: "issue_comment_post")
        try rt(IssuesState(available: true, provider: "github", state: "opened", issues: [summary]), tag: "issues_state")
        try rt(IssueDetail(number: 7, title: "T", state: "opened", body: nil, labels: [], author: "a", assignees: ["b"],
                           comments: [IssueNote(id: "1", author: "a", body: "b", createdAt: "x")], webUrl: nil,
                           canComment: false), tag: "issue_detail")
    }

    func testMacStatusAndCancels() throws {
        try rt(MacStatusList(), tag: "mac_status_list")
        try rt(MacStatus(projectName: "P", gitBranch: "main", workspacePath: nil, backendUp: true, mobileControlUp: true),
               tag: "mac_status")
        try rt(LlmIdeCancel(commandId: "c"), tag: "llmide_cancel")
        try rt(ExploreCancel(commandId: "c"), tag: "explore_cancel")
        try rt(ExploreRenameSession(sessionId: "s", title: "T"), tag: "explore_rename_session")
        try rt(ExploreSessionRenamed(sessionId: "s", title: "T"), tag: "explore_session_renamed")
    }

    func testProjects() throws {
        try rt(ProjectList(), tag: "project_list")
        try rt(ProjectSwitch(id: "p"), tag: "project_switch")
        try rt(ProjectState(active: ProjectInfo(id: "p", name: "P"),
                            projects: [ProjectInfo(id: "p", name: "P", lastOpenedAt: 3)], error: nil),
               tag: "project_state")
    }

    func testSelfHeal() throws {
        try rt(SelfHealList(), tag: "selfheal_list")
        for kind in [SelfHealAction.Kind.ignore, .retry, .apply, .discard] {
            try rt(SelfHealAction(incidentId: "i", action: kind), tag: "selfheal_action")
        }
        try rt(SelfHealDiffRequest(incidentId: "i"), tag: "selfheal_diff")
        try rt(SelfHealDiffResult(incidentId: "i", diff: "d", truncated: true, error: nil), tag: "selfheal_diff_result")
        try rt(SelfHealState(incidents: [SelfHealIncident(id: "i", source: "ui", category: "c", message: "m", count: 2,
                                                          status: "proposed", note: nil, lastSeen: 9, hasProposal: true,
                                                          branch: "b")],
                             canApply: false, enabled: true), tag: "selfheal_state")
    }

    func testSourceControl() throws {
        try rt(ScmStatusList(), tag: "scm_status_list")
        try rt(ScmDiffRequest(path: "a", staged: true), tag: "scm_diff")
        try rt(ScmDiffResult(path: "a", staged: false, diff: "d", truncated: false, error: nil), tag: "scm_diff_result")
        try rt(ScmState(isRepo: true, branch: "main", ahead: 1, behind: 0, hasUpstream: true,
                        files: [ScmFile(path: "a", status: "M", staged: false)], filesTruncated: false,
                        commits: [ScmCommit(sha: "abc", author: "a", relativeDate: "1d", subject: "s")], error: nil),
               tag: "scm_state")
    }

    func testToolApproval() throws {
        try rt(ToolApprovalRequest(commandId: "c", requestId: "r", toolName: "Edit", summary: "s", filePath: "~/a",
                                   oldString: "o", newString: "n", contentPreview: nil, command: nil,
                                   truncated: false, replaceAll: true, overwrites: nil), tag: "tool_approval_request")
        try rt(ToolApprovalAnswer(commandId: "c", requestId: "r", allow: true), tag: "tool_approval_answer")
    }

    func testUsage() throws {
        try rt(UsageGet(), tag: "usage_get")
        try rt(UsageState(provider: "claude", status: "ok", statusReason: nil, activeModel: "m",
                          models: [UsageMeter(name: "m", pct: 0.5, state: "ok", detail: "d", resetsAt: 1)],
                          subscription: [], subscriptionNote: nil, permissionMode: "review", error: nil),
               tag: "usage_state")
    }
}
