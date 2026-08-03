# Minicode

A lightweight implementation of a CLI coding agent harness.

## Architecture

```
+------------------------------------------------------+
| MiniCode CLI                                         |
| task · workspace · model · max steps                 |
+--------------------------+---------------------------+
                           |
                           v
+------------------------------------------------------+
| Coding Agent Loop                                    |
|                                                      |
|  +------------------+   +-------------------------+  |
|  | Context          |   | Language model          |  |
|  | - system prompt  |<->| - tool call             |  |
|  | - user task      |   | - completion request    |  |
|  | - tool results   |   +-------------------------+  |
|  +------------------+                                |
|                                                      |
|  +------------------+   +-------------------------+  |
|  | Workspace tools  |   | Completion checks       |  |
|  | - list / search  |   | - changed files         |  |
|  | - read / edit    |   | - fresh inspection      |  |
|  | - create / bash  |   | - bash verification     |  |
|  | - inspect        |   +-------------------------+  |
|  +------------------+                                |
+--------------------------+---------------------------+
                           |
                           v
+------------------------------------------------------+
| Run result                                           |
| completed · failed · cancelled                       |
+------------------------------------------------------+
```

## Quick start

```bash
# 1. Clone and build
git clone https://github.com/jithenms/minicode-agent.git
cd minicode-agent
pnpm install
pnpm build

# 2. Set your API key (OpenAI API key — not a ChatGPT subscription)
export OPENAI_API_KEY="sk-..."

# 3. Run a prompt
node dist/src/cli/main.js \
  "fix the bug ... and add a unit test." \
  --cwd /path/to/your/project \
  --model gpt-5.6-sol
```
