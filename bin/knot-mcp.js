#!/usr/bin/env node
import { serve } from '../src/server.js';

serve().catch((error) => {
    process.stderr.write(`knot-mcp: ${error?.message ?? error}\n`);
    process.exit(1);
});
