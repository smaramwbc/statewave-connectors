export interface JsonSchemaObject {
  type: "object";
  required?: ReadonlyArray<string>;
  properties?: Record<string, unknown>;
  additionalProperties?: boolean | object;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface McpServerOptions {
  statewaveUrl?: string;
  apiKey?: string;
  tenantId?: string;
}
