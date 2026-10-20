// Тестовый stdio MCP-сервер для smoke: пишет имя выполненного инструмента в файл SMOKE_MCP_LOG.
// SDK-серверы (createSdkMcpServer) для проверки ACL не годятся: CLI выполняет их без canUseTool.
//   node smoke-mcp-server.mjs jira|confluence
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const name = process.argv[2] ?? 'jira';
const TOOLS = {
  jira: [
    ['get_issue', 'Прочитать задачу Jira', false],
    ['create_issue', 'Создать задачу Jira', false],
    ['search', 'Поиск задач Jira', true],
  ],
  confluence: [['get_page', 'Прочитать страницу Confluence', true]],
};

const server = new McpServer({ name, version: '1.0.0' });
for (const [tool, description, readOnly] of TOOLS[name] ?? []) {
  server.registerTool(tool, { description, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) }, async () => {
    appendFileSync(process.env.SMOKE_MCP_LOG ?? '/dev/null', `mcp__${name}__${tool}\n`);
    return { content: [{ type: 'text', text: `${tool}: smoke` }] };
  });
}
await server.connect(new StdioServerTransport());
