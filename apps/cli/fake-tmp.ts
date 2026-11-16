import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
const h = createMcpHandler(() => new McpServer({name:"h",version:"1"}));
Bun.serve({port: 4999, fetch: async (r)=>{const c=r.clone(); const t=await c.text(); const res = await h.fetch(r); console.error(r.method, t.slice(0,90), res.status, (await res.clone().text()).slice(0,150)); return res;}});
