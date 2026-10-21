/** Example scripts written the first time the user opens or creates the Script Commands folder. */
export const EXAMPLE_SCRIPTS: Array<{ file: string; source: string }> = [
  {
    file: "hello-world.sh",
    source: `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Hello World
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 👋
# @raycast.packageName Examples
# @raycast.description Greets you (or whoever you type after the name)
# @raycast.argument1 { "type": "text", "placeholder": "Name", "optional": true }

echo "Hello, \${1:-world}!"
`,
  },
  {
    file: "system-info.sh",
    source: `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title System Info
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🖥️
# @raycast.packageName Examples
# @raycast.description macOS version, uptime and disk usage

echo "== macOS =="
sw_vers
echo
echo "== Uptime =="
uptime
echo
echo "== Disk =="
df -h /
`,
  },
];

export const NEW_SCRIPT_TEMPLATE = (title: string) => `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title ${title}
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🤖
# @raycast.packageName My Scripts
# @raycast.description Describe what this script does
# @raycast.argument1 { "type": "text", "placeholder": "Input", "optional": true }

echo "Hello from ${title}: $1"
`;
