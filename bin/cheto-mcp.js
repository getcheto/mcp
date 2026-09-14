#!/usr/bin/env node
import { serve } from '../src/server.js';

serve().catch((error) => {
    process.stderr.write(`cheto-mcp: ${error?.message ?? error}\n`);
    process.exit(1);
});
