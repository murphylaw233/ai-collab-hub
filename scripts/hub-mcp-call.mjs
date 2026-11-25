import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HUB_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'hub.json');

function parseCliArgs(argv) {
  const toolName = argv[0];
  if (!toolName) {
    throw new Error('Usage: node scripts/hub-mcp-call.mjs <toolName> (<jsonArgs> | --args-file <path>)');
  }

  let argsObj = {};
  if (argv[1] === '--args-file') {
    const filePath = argv[2];
    if (!filePath) throw new Error('--args-file requires a path');
    argsObj = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
  } else if (argv[1] !== undefined) {
    argsObj = JSON.parse(argv[1]);
  }
  return { toolName, argsObj };
}

async function main() {
  const { toolName, argsObj } = parseCliArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(HUB_CONFIG_PATH, 'utf8'));
  const host = config.host || '127.0.0.1';
  const port = config.port || 3789;
  const mcpUrl = `http://${host}:${port}/mcp/local`;

  const client = new Client({ name: 'hub-mcp-call-cli', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.localToken}`,
      },
    },
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: toolName,
      arguments: argsObj,
    });
    const text = (result.content ?? [])
      .map((item) => (typeof item.text === 'string' ? item.text : JSON.stringify(item)))
      .join('\n');
    console.log(text);
    if (result.isError) {
      process.exitCode = 1;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[hub-mcp-call] FAILED:', err?.message || err);
  process.exitCode = 1;
});
