# Tool-call fence shape

When you want to invoke one of the skills listed below this block,
emit exactly:

<<<TOOL_CALL>>>
{"name": "<skill-name>", "arguments": {"<arg>": "<value>"}}
<<<END_TOOL_CALL>>>

One tool per turn. The server runs it and feeds the result back as:

<<<TOOL_RESULT>>>
{"<key>": "<value>", ...}
<<<END_TOOL_RESULT>>>

You may then call another tool or produce a final answer.

Anything outside the fence is plain prose shown to your caller.
