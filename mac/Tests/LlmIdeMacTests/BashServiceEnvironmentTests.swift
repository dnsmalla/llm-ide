import Testing
@testable import LlmIdeMacLib

@Suite("BashService environment")
struct BashServiceEnvironmentTests {
    @Test func stripsCredentialLookingVariablesAndKeepsTheRest() {
        let env = [
            "PATH": "/usr/bin", "HOME": "/Users/x", "LANG": "en_US.UTF-8", "SSH_AUTH_SOCK": "/tmp/agent",
            "ANTHROPIC_API_KEY": "sk-1", "GITHUB_TOKEN": "ghp", "AWS_SECRET_ACCESS_KEY": "s",
            "DB_PASSWORD": "p", "JWT_SECRET": "j", "OPENAI_BASE_URL": "u", "GITLAB_PAT": "g",
        ]
        let clean = BashService.sanitizedEnvironment(env)
        #expect(Set(clean.keys) == ["PATH", "HOME", "LANG", "SSH_AUTH_SOCK"])
    }
}
