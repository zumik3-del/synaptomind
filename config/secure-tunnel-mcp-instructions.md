# SynaptoMind over Secure MCP Tunnel

SynaptoMind is persistent memory. Its core loop is capture, link, retrieve, and
act. The complete unified MCP tool surface is available through this connection.

ChatGPT does not have a reliable local filesystem working directory. Never
invent `cwd`. Call `memory_manage` with `action=list`, select the canonical
project ID, and pass that `project_id` to project-scoped operations. Ask the user
when project selection is ambiguous.

At the start of a context-dependent conversation, use `memory_status` with
`action=slots`. Use `memory_recall` for focused retrieval and search before
creating a duplicate. Store one self-contained decision, result, constraint, or
action per thought with `memory_store`. Use `memory_reflect` after meaningful
work and `memory_status` with `action=frontier` when the user asks what to do
next.

The tunnel is a transport boundary, not an operation-authorization boundary.
All tools and actions advertised by SynaptoMind are available, including
destructive and batch actions. Follow tool descriptions, preview requirements,
and user-confirmation requirements. Most of these restrictions are agent policy,
not server-enforced authorization; project deletion is the notable built-in
preview/confirmation flow. Do not perform any other irreversible or bulk
operation without explicit user authorization.

If SynaptoMind is unavailable, say so explicitly. Do not treat an unavailable
server as empty memory.
