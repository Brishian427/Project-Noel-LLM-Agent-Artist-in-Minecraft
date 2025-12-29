// Litematic to Blueprint Converter
// Created: 2024-12-19
// Converts .litematic files to agent.js blueprint format

const fs = require('fs');
const path = require('path');

// Try to use prismarine-nbt for NBT parsing (litematic files are NBT-compressed)
let nbt;
try {
    nbt = require('prismarine-nbt');
} catch (e) {
    console.error('Error: prismarine-nbt not found. Installing...');
    console.error('Please run: npm install prismarine-nbt');
    process.exit(1);
}

async function convertLitematicToBlueprint(filePath) {
    try {
        console.log(`[CONVERT] Reading litematic file: ${filePath}`);
        const buffer = fs.readFileSync(filePath);
        
        // Parse NBT data
        console.log('[CONVERT] Parsing NBT data...');
        const parsed = await nbt.parse(buffer);
        const nbtData = nbt.simplify(parsed);
        
        console.log('[CONVERT] NBT structure:', JSON.stringify(Object.keys(nbtData), null, 2));
        
        // Litematic file structure:
        // - Metadata
        // - Regions (contains the actual block data)
        if (!nbtData.Metadata || !nbtData.Regions) {
            console.error('[CONVERT] Invalid litematic file structure');
            console.error('[CONVERT] Available keys:', Object.keys(nbtData));
            return;
        }
        
        const regions = nbtData.Regions;
        const regionNames = Object.keys(regions);
        
        if (regionNames.length === 0) {
            console.error('[CONVERT] No regions found in litematic file');
            return;
        }
        
        console.log(`[CONVERT] Found ${regionNames.length} region(s): ${regionNames.join(', ')}`);
        
        // Process the first region (or all regions)
        const regionName = regionNames[0];
        const region = regions[regionName];
        
        console.log(`[CONVERT] Processing region: ${regionName}`);
        console.log(`[CONVERT] Region size: ${JSON.stringify(region.Size)}`);
        console.log(`[CONVERT] Region position: ${JSON.stringify(region.Position)}`);
        
        // Get block states and palette
        const blockStates = region.BlockStates;
        const palette = region.BlockStatePalette || [];
        
        if (!blockStates || !palette) {
            console.error('[CONVERT] Missing block states or palette');
            return;
        }
        
        console.log(`[CONVERT] Palette size: ${palette.length} unique blocks`);
        console.log(`[CONVERT] Block states array length: ${blockStates.length}`);
        
        // Calculate dimensions
        const size = region.Size;
        const width = size[0] || size.x || 1;
        const height = size[1] || size.y || 1;
        const length = size[2] || size.z || 1;
        
        console.log(`[CONVERT] Dimensions: ${width} x ${height} x ${length}`);
        
        // Get position offset
        const position = region.Position || [0, 0, 0];
        const offsetX = position[0] || position.x || 0;
        const offsetY = position[1] || position.y || 0;
        const offsetZ = position[2] || position.z || 0;
        
        console.log(`[CONVERT] Position offset: (${offsetX}, ${offsetY}, ${offsetZ})`);
        
        // Calculate bits per block (for palette index)
        const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(palette.length)));
        console.log(`[CONVERT] Bits per block: ${bitsPerBlock}`);
        
        // Generate blueprint array
        const blueprint = [];
        let blockCount = 0;
        
        // Litematic uses a compacted long array format
        // We need to decode the block states array
        for (let y = 0; y < height; y++) {
            for (let z = 0; z < length; z++) {
                for (let x = 0; x < width; x++) {
                    // Calculate index in the block states array
                    const index = (y * length * width) + (z * width) + x;
                    
                    // Get palette index from block states
                    // This is a simplified approach - actual decoding may be more complex
                    let paletteIndex = 0;
                    
                    if (Array.isArray(blockStates)) {
                        // If blockStates is an array of numbers
                        if (index < blockStates.length) {
                            paletteIndex = blockStates[index];
                        }
                    } else if (typeof blockStates === 'object' && blockStates.data) {
                        // If blockStates has a data array (compacted format)
                        const dataArray = blockStates.data;
                        const longIndex = Math.floor((index * bitsPerBlock) / 64);
                        const bitOffset = (index * bitsPerBlock) % 64;
                        
                        if (longIndex < dataArray.length) {
                            const longValue = BigInt(dataArray[longIndex]);
                            const mask = (BigInt(1) << BigInt(bitsPerBlock)) - BigInt(1);
                            paletteIndex = Number((longValue >> BigInt(bitOffset)) & mask);
                        }
                    }
                    
                    // Get block from palette
                    if (paletteIndex >= 0 && paletteIndex < palette.length) {
                        const blockData = palette[paletteIndex];
                        
                        // Extract block name
                        let blockName = 'air';
                        if (typeof blockData === 'string') {
                            blockName = blockData;
                        } else if (blockData && blockData.Name) {
                            blockName = blockData.Name;
                        } else if (blockData && typeof blockData === 'object') {
                            // Try to find name property
                            blockName = blockData.name || blockData.block || 'air';
                        }
                        
                        // Skip air blocks
                        if (blockName && blockName !== 'minecraft:air' && blockName !== 'air') {
                            // Remove 'minecraft:' prefix if present
                            const shortName = blockName.replace(/^minecraft:/, '');
                            
                            // Calculate relative position (subtract offset to center at origin)
                            const relX = x - offsetX;
                            const relY = y - offsetY;
                            const relZ = z - offsetZ;
                            
                            blueprint.push({
                                block: shortName,
                                pos: { x: relX, y: relY, z: relZ }
                            });
                            blockCount++;
                        }
                    }
                }
            }
        }
        
        console.log(`[CONVERT] Generated ${blockCount} non-air blocks`);
        
        // Output blueprint code
        console.log('\n// ==========================================');
        console.log('// Generated Blueprint Code');
        console.log('// ==========================================\n');
        console.log('const blueprint = [');
        
        blueprint.forEach((entry, index) => {
            const comma = index < blueprint.length - 1 ? ',' : '';
            console.log(`    { block: '${entry.block}', pos: new Vec3(${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}) }${comma}`);
        });
        
        console.log('];\n');
        console.log('// ==========================================');
        console.log(`// Total blocks: ${blockCount}`);
        console.log('// ==========================================\n');
        
        // Also save to file
        const outputFile = path.join(__dirname, 'blueprint-output.txt');
        let output = 'const blueprint = [\n';
        blueprint.forEach((entry, index) => {
            const comma = index < blueprint.length - 1 ? ',' : '';
            output += `    { block: '${entry.block}', pos: new Vec3(${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}) }${comma}\n`;
        });
        output += '];\n';
        
        fs.writeFileSync(outputFile, output);
        console.log(`[CONVERT] Blueprint code saved to: ${outputFile}`);
        
    } catch (error) {
        console.error('[CONVERT] Error converting litematic file:', error);
        console.error('[CONVERT] Stack:', error.stack);
        
        // Try alternative parsing method
        console.log('\n[CONVERT] Attempting alternative parsing method...');
        tryAlternativeParsing(filePath);
    }
}

async function tryAlternativeParsing(filePath) {
    try {
        // Try reading as raw buffer and looking for patterns
        const buffer = fs.readFileSync(filePath);
        console.log(`[CONVERT] File size: ${buffer.length} bytes`);
        
        // This is a fallback - litematic files are complex NBT structures
        console.log('[CONVERT] Litematic files require specialized parsing.');
        console.log('[CONVERT] Please consider using Litematica mod to export as .schematic or .nbt format.');
        console.log('[CONVERT] Or use an online converter tool.');
    } catch (error) {
        console.error('[CONVERT] Alternative parsing also failed:', error.message);
    }
}

// Main execution
const litematicFile = process.argv[2] || '17353.litematic';

if (!fs.existsSync(litematicFile)) {
    console.error(`[CONVERT] File not found: ${litematicFile}`);
    console.error('[CONVERT] Usage: node convert-litematic.js <path-to-litematic-file>');
    process.exit(1);
}

convertLitematicToBlueprint(litematicFile).catch(error => {
    console.error('[CONVERT] Fatal error:', error);
    process.exit(1);
});

