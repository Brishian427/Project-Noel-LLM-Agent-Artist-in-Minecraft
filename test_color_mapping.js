#!/usr/bin/env node
/**
 * Test Color Mapping Debug Script
 * Created: 2024-12-19
 * Tests color mapping from voxelizer.py output to blueprint format
 */

const fs = require('fs');
const path = require('path');

// Mock Vec3 class for testing
class Vec3 {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
}

// Test function: Simulate process3DModel reading JSON
function testBlueprintReading(jsonPath) {
    console.log('='.repeat(60));
    console.log('[TEST] Testing Blueprint Color Mapping');
    console.log('='.repeat(60));
    console.log(`[TEST] Reading JSON file: ${jsonPath}\n`);
    
    if (!fs.existsSync(jsonPath)) {
        console.error(`[ERROR] JSON file not found: ${jsonPath}`);
        console.log('\n[INFO] To generate a test JSON, run:');
        console.log('  python voxelizer.py <model_file> <output.json> [resolution]');
        return;
    }
    
    try {
        // Read JSON file
        const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
        const blueprintData = JSON.parse(jsonContent);
        
        console.log(`[TEST] JSON parsed successfully`);
        console.log(`[TEST] Total entries: ${blueprintData.length}\n`);
        
        // Check first few entries
        console.log('[TEST] Sample entries from JSON:');
        for (let i = 0; i < Math.min(5, blueprintData.length); i++) {
            console.log(`  Entry ${i + 1}:`, JSON.stringify(blueprintData[i], null, 2));
        }
        console.log();
        
        // Check structure
        if (blueprintData.length > 0) {
            const firstEntry = blueprintData[0];
            console.log('[TEST] Entry structure analysis:');
            console.log(`  Keys: ${Object.keys(firstEntry).join(', ')}`);
            console.log(`  Has 'block' field: ${firstEntry.hasOwnProperty('block')}`);
            console.log(`  Has 'r' field: ${firstEntry.hasOwnProperty('r')}`);
            console.log(`  Has 'g' field: ${firstEntry.hasOwnProperty('g')}`);
            console.log(`  Has 'b' field: ${firstEntry.hasOwnProperty('b')}`);
            console.log(`  Has 'x' field: ${firstEntry.hasOwnProperty('x')}`);
            console.log(`  Has 'y' field: ${firstEntry.hasOwnProperty('y')}`);
            console.log(`  Has 'z' field: ${firstEntry.hasOwnProperty('z')}`);
            console.log();
            
            if (firstEntry.block) {
                console.log(`  Block name: "${firstEntry.block}"`);
            } else {
                console.log(`  ⚠️  WARNING: Missing 'block' field!`);
            }
            
            if (firstEntry.r !== undefined && firstEntry.g !== undefined && firstEntry.b !== undefined) {
                console.log(`  RGB: (${firstEntry.r}, ${firstEntry.g}, ${firstEntry.b})`);
            }
        }
        console.log();
        
        // Simulate blueprint conversion (same as generalised_agent.js)
        console.log('[TEST] Converting to blueprint format...');
        const blueprint = blueprintData.map(entry => {
            const blockName = entry.block;
            if (!blockName) {
                console.warn(`  ⚠️  Missing block field for entry at (${entry.x}, ${entry.y}, ${entry.z})`);
            }
            return {
                block: blockName || 'quartz_block',
                pos: new Vec3(entry.x || 0, entry.y || 0, entry.z || 0)
            };
        });
        
        // Analyze block distribution
        console.log('\n[TEST] Block distribution analysis:');
        const blockCounts = {};
        blueprint.forEach(entry => {
            blockCounts[entry.block] = (blockCounts[entry.block] || 0) + 1;
        });
        
        const uniqueBlocks = Object.keys(blockCounts);
        console.log(`  Total unique block types: ${uniqueBlocks.length}`);
        console.log(`  Block distribution:`);
        for (const [block, count] of Object.entries(blockCounts)) {
            const percentage = ((count / blueprint.length) * 100).toFixed(2);
            console.log(`    ${block}: ${count} (${percentage}%)`);
        }
        console.log();
        
        // Check for issues
        if (uniqueBlocks.length === 1) {
            console.log('  ⚠️  WARNING: Only one block type found!');
            console.log(`     This suggests color mapping may have failed.`);
            console.log(`     All blocks are: ${uniqueBlocks[0]}`);
        } else if (uniqueBlocks.length <= 3) {
            console.log('  ⚠️  WARNING: Very few block types found.');
            console.log(`     This might indicate limited color diversity in the model.`);
        } else {
            console.log('  ✓ Color mapping appears successful!');
        }
        
        // Check if all are default
        const defaultBlockCount = blueprint.filter(e => e.block === 'quartz_block').length;
        if (defaultBlockCount === blueprint.length) {
            console.log('\n  ❌ CRITICAL: All blocks are default (quartz_block)!');
            console.log('     Color mapping definitely failed!');
        } else if (defaultBlockCount > blueprint.length * 0.5) {
            console.log(`\n  ⚠️  WARNING: ${defaultBlockCount} out of ${blueprint.length} blocks are default.`);
            console.log('     This suggests many entries are missing block fields.');
        }
        
        // Check RGB diversity in original data
        if (blueprintData.length > 0 && blueprintData[0].hasOwnProperty('r')) {
            console.log('\n[TEST] RGB color diversity in original data:');
            const uniqueColors = new Set();
            blueprintData.forEach(entry => {
                if (entry.r !== undefined && entry.g !== undefined && entry.b !== undefined) {
                    uniqueColors.add(`${entry.r},${entry.g},${entry.b}`);
                }
            });
            console.log(`  Unique RGB colors: ${uniqueColors.size}`);
            
            if (uniqueColors.size === 1) {
                const firstColor = Array.from(uniqueColors)[0];
                console.log(`  ⚠️  WARNING: Only one RGB color found: (${firstColor})`);
                console.log(`     The model may not have color information!`);
            } else {
                const rValues = blueprintData.map(e => e.r).filter(r => r !== undefined);
                const gValues = blueprintData.map(e => e.g).filter(g => g !== undefined);
                const bValues = blueprintData.map(e => e.b).filter(b => b !== undefined);
                if (rValues.length > 0) {
                    console.log(`  RGB range: R(${Math.min(...rValues)}-${Math.max(...rValues)}), ` +
                               `G(${Math.min(...gValues)}-${Math.max(...gValues)}), ` +
                               `B(${Math.min(...bValues)}-${Math.max(...bValues)})`);
                }
            }
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('[TEST] Analysis complete!');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error(`[ERROR] Failed to process JSON: ${error.message}`);
        console.error(error.stack);
    }
}

// Main execution
const args = process.argv.slice(2);
if (args.length === 0) {
    // Try to find JSON files in assets directory
    const assetsDir = path.join(__dirname, 'assets');
    if (fs.existsSync(assetsDir)) {
        const jsonFiles = fs.readdirSync(assetsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => path.join(assetsDir, f));
        
        if (jsonFiles.length > 0) {
            console.log('[INFO] Found JSON files in assets directory:');
            jsonFiles.forEach((f, i) => {
                console.log(`  ${i + 1}. ${f}`);
            });
            console.log('\n[INFO] Testing first file...\n');
            testBlueprintReading(jsonFiles[0]);
        } else {
            console.log('[INFO] No JSON files found in assets directory.');
            console.log('\nUsage: node test_color_mapping.js <path_to_json_file>');
            console.log('Example: node test_color_mapping.js assets/blueprint.json');
        }
    } else {
        console.log('[INFO] Assets directory not found.');
        console.log('\nUsage: node test_color_mapping.js <path_to_json_file>');
        console.log('Example: node test_color_mapping.js assets/blueprint.json');
    }
} else {
    testBlueprintReading(args[0]);
}

