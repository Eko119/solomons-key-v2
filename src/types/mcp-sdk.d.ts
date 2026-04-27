declare module '@modelcontextprotocol/sdk/client' {
  interface Implementation {
    name: string;
    version: string;
  }

  interface Tool {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }

  class Client {
    constructor(info: Implementation, options?: Record<string, unknown>);
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools: Tool[] }>;
    ping(): Promise<unknown>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  interface StdioServerParameters {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }

  class StdioClientTransport {
    constructor(params: StdioServerParameters);
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  class StreamableHTTPClientTransport {
    constructor(url: URL, options?: { requestInit?: { headers?: Record<string, string> } });
  }
}
