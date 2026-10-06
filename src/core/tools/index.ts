import { filesystemTools } from './filesystem.js';
import { searchTools } from './search.js';
import { terminalTools } from './terminal.js';
import { processTools } from './processTools.js';
import { gitTools } from './gitTools.js';
import { testingTools } from './testing.js';
import { metaTools } from './meta.js';
import { ToolManager } from './registry.js';
import type { Tool } from './types.js';

export * from './types.js';
export * from './registry.js';
export * from './validate.js';
export { filesystemTools, searchTools, terminalTools, processTools, gitTools, testingTools, metaTools };

export function allTools(): Tool[] {
  return [...filesystemTools, ...searchTools, ...terminalTools, ...processTools, ...gitTools, ...testingTools, ...metaTools];
}

export function createToolManager(): ToolManager {
  return new ToolManager(allTools());
}
