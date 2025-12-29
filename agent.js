// Project Noël - Minecraft Agent
// Created: 2024-12-19
// Architecture: Silmaril Pattern (Cognitive/Motor/Actuation Layers)

require('dotenv').config();

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalNear } = require('mineflayer-pathfinder').goals;
const { Movements } = require('mineflayer-pathfinder');
const { OpenAI } = require('openai');
const Vec3 = require('vec3').Vec3;
const fs = require('fs');
const path = require('path');

// Environment Initialisation
// Skin configuration: 
// - For premium account skin, set MINECRAFT_USERNAME and MINECRAFT_PASSWORD in .env
// - For custom username (offline mode), change username below
// - Server-side skin plugins (like SkinRestorer) can also set skins
const BOT_CONFIG = {
    host: 'localhost',
    port: 25565,
    username: process.env.MINECRAFT_USERNAME || 'NoelBot', // Use env var or default
    version: '1.20.1',
    // Uncomment below for premium account authentication (skin loads automatically)
    // auth: process.env.MINECRAFT_AUTH_TYPE || 'offline', // 'microsoft', 'mojang', or 'offline'
    // password: process.env.MINECRAFT_PASSWORD, // Required if using premium account
};

if (!process.env.OPENAI_API_KEY) {
    console.error('[ERROR] OPENAI_API_KEY environment variable is not set');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const bot = mineflayer.createBot(BOT_CONFIG);

// Load pathfinder plugin
bot.loadPlugin(pathfinder);

// Configure pathfinder movements for creative mode (flying support)
let pathfinderMovements = null;

// Natural Behavior System - Makes bot act like a real player/NPC
const BEHAVIOR_CONFIG = {
    enabled: true,
    // Block breaking is PERMANENTLY DISABLED - agent cannot break any blocks
    // This setting is kept for reference but has no effect (breaking is always disabled)
    allowBlockBreaking: false,  // Permanently disabled - cannot be enabled
    // Silence command feedback in chat (setblock, tp commands)
    silentMode: true,  // Set to false to see command feedback in chat
    // If you've already set /gamerule sendCommandFeedback false on the server,
    // set this to false to skip the command (avoids unnecessary command execution)
    setCommandFeedbackRule: false,  // Set to true if you want agent to set it automatically
    followPlayer: {
        enabled: true,
        detectionRange: 30,      // Detection range in blocks
        followDistance: 3,        // Keep this distance from player
        followInterval: 200,    // Check for players every 2 seconds
        priority: true           // Priority over random walk
    },
    randomWalk: {
        enabled: true,
        interval: 10000, // 10 seconds between random walks
        maxDistance: 10, // Maximum distance to walk
        minDistance: 5   // Minimum distance to walk
    },
    lookAround: {
        enabled: true,
        interval: 3000,  // 3 seconds between look movements
        maxYaw: Math.PI,  // Max horizontal rotation
        maxPitch: Math.PI / 3 // Max vertical rotation (60 degrees)
    },
    idleActions: {
        enabled: true,
        jumpChance: 0,  // 10% chance to jump when idle
        interval: 5000    // Check every 5 seconds
    }
};

let behaviorState = {
    isMoving: false,
    isLooking: false,
    isFollowing: false,
    followingPlayer: null,
    isExecutingTask: false, // Flag to disable following during task execution
    workCenter: null, // Center position for current work (building task)
    maxWorkDistance: 8, // Maximum distance from work center
    minWorkDistance: 2, // Minimum distance from work center (to avoid getting too close)
    lastWalkTime: 0,
    lastLookTime: 0,
    lastIdleActionTime: 0,
    lastFollowCheck: 0,
    currentGoal: null,
    // Flight control state
    lastJumpTime: 0, // Last time jump/space was pressed
    minJumpInterval: 3000, // Minimum 3 seconds between jumps when flying
    isJumping: false, // Currently holding jump key
    jumpStartTime: 0, // When current jump started
    // Behavior system intervals (for cleanup)
    behaviorIntervals: [] // Store interval IDs to clear them when needed
};

// Conversation history for context-aware responses
const conversationHistory = [];

// Rate limiting and retry configuration
const RATE_LIMIT_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 60000, // 60 seconds
    requestDelay: 500 // Delay between requests to avoid rate limits
};

// Last request timestamp for rate limiting
let lastRequestTime = 0;

// API Usage Tracking
const API_USAGE = {
    requests: 0,
    tokens: {
        prompt: 0,
        completion: 0,
        total: 0
    },
    cost: {
        total: 0,
        usd: 0
    },
    startTime: Date.now(),
    lastReset: Date.now()
};

// GPT-4o Pricing (as of 2024, per 1M tokens)
const PRICING = {
    'gpt-4o': {
        prompt: 2.50,    // $2.50 per 1M input tokens
        completion: 10.00 // $10.00 per 1M output tokens
    }
};

/**
 * Track API usage and calculate costs
 * @param {Object} usage - Usage data from API response
 */
function trackAPIUsage(usage) {
    if (!usage) return;
    
    API_USAGE.requests++;
    
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
    
    API_USAGE.tokens.prompt += promptTokens;
    API_USAGE.tokens.completion += completionTokens;
    API_USAGE.tokens.total += totalTokens;
    
    // Calculate cost (in USD)
    const model = 'gpt-4o';
    const promptCost = (promptTokens / 1_000_000) * PRICING[model].prompt;
    const completionCost = (completionTokens / 1_000_000) * PRICING[model].completion;
    const totalCost = promptCost + completionCost;
    
    API_USAGE.cost.total += totalCost;
    API_USAGE.cost.usd = API_USAGE.cost.total;
    
    // Log usage periodically
    if (API_USAGE.requests % 10 === 0) {
        logAPIUsage();
    }
    
    // Warn if usage is high
    if (API_USAGE.cost.usd > 1.0) {
        console.warn(`[API] ⚠️  Current session cost: $${API_USAGE.cost.usd.toFixed(4)}`);
    }
}

/**
 * Log current API usage statistics
 */
function logAPIUsage() {
    const runtime = Math.floor((Date.now() - API_USAGE.startTime) / 1000 / 60); // minutes
    const avgCostPerRequest = API_USAGE.requests > 0 ? API_USAGE.cost.usd / API_USAGE.requests : 0;
    
    console.log('\n========================================');
    console.log('📊 API Usage Statistics');
    console.log('========================================');
    console.log(`Requests: ${API_USAGE.requests}`);
    console.log(`Tokens:`);
    console.log(`  - Prompt: ${API_USAGE.tokens.prompt.toLocaleString()}`);
    console.log(`  - Completion: ${API_USAGE.tokens.completion.toLocaleString()}`);
    console.log(`  - Total: ${API_USAGE.tokens.total.toLocaleString()}`);
    console.log(`Cost: $${API_USAGE.cost.usd.toFixed(4)} USD`);
    console.log(`Runtime: ${runtime} minutes`);
    console.log(`Avg cost per request: $${avgCostPerRequest.toFixed(6)}`);
    console.log('========================================\n');
}

/**
 * Get API usage summary
 * @returns {Object} Usage statistics
 */
function getAPIUsage() {
    const runtime = Math.floor((Date.now() - API_USAGE.startTime) / 1000 / 60);
    return {
        ...API_USAGE,
        runtime: runtime,
        avgCostPerRequest: API_USAGE.requests > 0 ? API_USAGE.cost.usd / API_USAGE.requests : 0,
        tokensPerRequest: API_USAGE.requests > 0 ? API_USAGE.tokens.total / API_USAGE.requests : 0
    };
}

// System prompt for OpenAI
const SYSTEM_PROMPT = `You are Project Noël, a Minecraft agent following the Silmaril architecture pattern.
You have access to the following actions:
- nod: Perform a physical nodding gesture to acknowledge
- build: Build a Christmas tree at your current location
- celebrate: Summon fireworks to celebrate

When users request actions, use the execute_tasks tool with the appropriate action.
Be concise and helpful in your responses.`;

/**
 * Call OpenAI API with rate limit handling and retry logic
 * @param {Function} apiCall - Function that returns a Promise for the API call
 * @param {number} retryCount - Current retry attempt
 * @returns {Promise} API response
 */
async function callOpenAIWithRetry(apiCall, retryCount = 0) {
    try {
        // Rate limiting: ensure minimum delay between requests
        const timeSinceLastRequest = Date.now() - lastRequestTime;
        if (timeSinceLastRequest < RATE_LIMIT_CONFIG.requestDelay) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_CONFIG.requestDelay - timeSinceLastRequest));
        }
        lastRequestTime = Date.now();

        return await apiCall();
    } catch (error) {
        // Check if it's a rate limit error
        const isRateLimit = error.status === 429 || 
                           error.message?.includes('rate limit') || 
                           error.message?.includes('Rate limit') ||
                           error.code === 'rate_limit_exceeded';

        if (isRateLimit && retryCount < RATE_LIMIT_CONFIG.maxRetries) {
            // Calculate exponential backoff delay
            const delay = Math.min(
                RATE_LIMIT_CONFIG.baseDelay * Math.pow(2, retryCount),
                RATE_LIMIT_CONFIG.maxDelay
            );
            
            console.warn(`[API] Rate limit hit, retrying in ${delay}ms (attempt ${retryCount + 1}/${RATE_LIMIT_CONFIG.maxRetries})`);
            
            // If error has retry-after header, use that instead
            const retryAfter = error.headers?.['retry-after'] || error.response?.headers?.['retry-after'];
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callOpenAIWithRetry(apiCall, retryCount + 1);
        }

        // If not rate limit or max retries reached, throw error
        throw error;
    }
}

/**
 * Check if bot is currently flying
 * @returns {boolean} True if bot is flying
 */
function isFlying() {
    // In creative mode, use more reliable detection
    if (bot.game.gameMode === 1) { // Creative mode
        const entity = bot.entity;
        const pos = entity.position;
        
        // Method 1: Check if not on ground
        if (!entity.onGround) {
            return true;
        }
        
        // Method 2: Check velocity (even small upward velocity indicates flight attempt)
        const velocity = entity.velocity;
        if (velocity && Math.abs(velocity.y) > 0.001) {
            return true; // Any vertical movement in creative mode
        }
        
        // Method 3: Check if we're significantly above ground (more than 0.5 blocks)
        // Check multiple blocks below to see if we're floating
        let airBlocksBelow = 0;
        for (let i = 1; i <= 3; i++) {
            const blockBelow = bot.blockAt(pos.minus(new Vec3(0, i, 0)));
            if (blockBelow && (blockBelow.name === 'air' || blockBelow.type === 0)) {
                airBlocksBelow++;
            } else {
                break;
            }
        }
        if (airBlocksBelow >= 2) {
            // At least 2 air blocks below, likely flying
            return true;
        }
        
        // Method 4: If we're executing a task and moving vertically, assume flying
        if (behaviorState.isExecutingTask) {
            // During building tasks in creative mode, we're likely trying to fly
            return true;
        }
    }
    return false;
}

/**
 * Press jump/space key with duration control
 * DISABLED during task execution - no jump control when building
 * @param {number} duration - How long to hold jump (ms), 0 for short press
 * @param {boolean} force - Force jump even if interval not met (default: false)
 * @returns {Promise<boolean>} True if jump was executed, false if skipped
 */
async function pressJump(duration = 0, force = false) {
    // CRITICAL: Disable jump control during task execution
    if (behaviorState.isExecutingTask) {
        console.log('[FLIGHT] Jump disabled during task execution');
        return false;
    }
    
    const now = Date.now();
    const timeSinceLastJump = now - behaviorState.lastJumpTime;
    
    // Check if we're flying
    const flying = isFlying();
    
    // Always enforce minimum interval in creative mode (even if not detected as flying)
    // This prevents rapid double-tap issues
    if (bot.game.gameMode === 1 && !force) {
        if (timeSinceLastJump < behaviorState.minJumpInterval) {
            const waitTime = behaviorState.minJumpInterval - timeSinceLastJump;
            console.log(`[FLIGHT] Waiting ${waitTime}ms before next jump (${flying ? 'flying' : 'creative'} mode)`);
            return false; // Skip this jump
        }
    }
    
    // Additional check: if flying, enforce stricter interval
    if (flying && !force) {
        if (timeSinceLastJump < behaviorState.minJumpInterval) {
            const waitTime = behaviorState.minJumpInterval - timeSinceLastJump;
            console.log(`[FLIGHT] Waiting ${waitTime}ms before next jump (flying mode)`);
            return false; // Skip this jump
        }
    }
    
    // Execute jump
    behaviorState.isJumping = true;
    behaviorState.jumpStartTime = now;
    behaviorState.lastJumpTime = now;
    
    bot.setControlState('jump', true);
    
    // If duration specified, hold for that duration, otherwise use short press
    const holdDuration = duration > 0 ? duration : 200; // Default short press: 200ms
    
    await new Promise(resolve => setTimeout(resolve, holdDuration));
    
    bot.setControlState('jump', false);
    behaviorState.isJumping = false;
    
    // More descriptive log message
    const modeStr = flying ? 'flying' : (bot.game.gameMode === 1 ? 'creative' : 'ground');
    const jumpTypeStr = holdDuration >= 700 ? 'long-press' : (holdDuration >= 400 ? 'medium-press' : 'short-press');
    console.log(`[FLIGHT] Jump executed (${modeStr} mode, ${jumpTypeStr}: ${holdDuration}ms hold, next jump allowed after ${behaviorState.minJumpInterval}ms)`);
    return true;
}

// SKILLS Module - Hard-coded Primitives (Actuation Layer)
const SKILLS = {
    // NOTE: safeDig function has been completely removed
    // Block breaking is permanently disabled - agent cannot break any blocks

    /**
     * Finds the first solid block below the given position
     * @param {Vec3} pos - Position to probe from
     * @returns {Promise<Vec3|null>} Ground position or null if not found
     */
    async findGround(pos) {
        try {
            console.log(`[SKILLS] Probing ground at ${pos.toString()}`);
            const maxProbeDepth = 64;
            
            for (let y = pos.y; y >= pos.y - maxProbeDepth; y--) {
                const probePos = new Vec3(pos.x, y, pos.z);
                const block = bot.blockAt(probePos);
                
                if (block && block.type !== 0 && block.name !== 'air') {
                    console.log(`[SKILLS] Found ground at ${probePos.toString()}`);
                    return probePos;
                }
            }
            
            console.log(`[SKILLS] No ground found below ${pos.toString()}`);
            return null;
        } catch (error) {
            console.error(`[SKILLS] Error in findGround: ${error.message}`);
            throw error;
        }
    },

    /**
     * Gets an item from inventory or creates it using command (for LAN games)
     * @param {string} itemName - Item name (e.g., 'oak_log', 'spruce_leaves')
     * @returns {Promise<Object|null>} Item object or null
     */
    async getOrCreateItem(itemName) {
        // Try to find item in inventory first
        const items = bot.inventory.items();
        const item = items.find(i => i.name === itemName);
        if (item) {
            return item;
        }

        // If not found, try to get it via command (works in creative mode or with cheats)
        try {
            const fullName = `minecraft:${itemName}`;
            bot.chat(`/give @s ${fullName} 64`);
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check again after giving
            const itemsAfter = bot.inventory.items();
            const itemAfter = itemsAfter.find(i => i.name === itemName);
            return itemAfter || null;
        } catch (error) {
            console.warn(`[SKILLS] Could not get item ${itemName}: ${error.message}`);
            return null;
        }
    },

    /**
     * Finds the best position to stand to place a block at targetPos
     * @param {Vec3} targetPos - Target block position
     * @param {number} maxDistance - Maximum placement distance (default: 5)
     * @returns {Promise<Vec3|null>} Best position to stand, or null if not found
     */
    async findBestPlacementPosition(targetPos, maxDistance = 5) {
        const directions = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
            new Vec3(1, 0, 1), new Vec3(-1, 0, -1),
            new Vec3(1, 0, -1), new Vec3(-1, 0, 1)
        ];

        // Try positions around the target
        for (const dir of directions) {
            for (let dist = 1; dist <= maxDistance; dist++) {
                const candidatePos = targetPos.plus(dir.scaled(dist));
                candidatePos.y = Math.floor(candidatePos.y);
                
                // Check if position is safe to stand
                const blockBelow = bot.blockAt(candidatePos.plus(new Vec3(0, -1, 0)));
                const blockAt = bot.blockAt(candidatePos);
                const blockAbove = bot.blockAt(candidatePos.plus(new Vec3(0, 1, 0)));
                
                if (blockBelow && blockBelow.name !== 'air' && 
                    (!blockAt || blockAt.name === 'air') &&
                    (!blockAbove || blockAbove.name === 'air')) {
                    return candidatePos;
                }
            }
        }
        
        return null;
    },

    /**
     * Moves bot to a position, with flying support
     * Bot will fly to reach positions in the air
     * @param {Vec3} targetPos - Target position
     * @param {number} tolerance - Distance tolerance (default: 1)
     * @returns {Promise<boolean>} Success status
     */
    async moveToPosition(targetPos, tolerance = 1) {
        try {
            const currentPos = bot.entity.position;
            const distance = currentPos.distanceTo(targetPos);
            
            if (distance <= tolerance) {
                return true;
            }

            // Always ensure creative mode is enabled
            // Block breaking is still disabled via code protection (bot.dig override)
            try {
                bot.chat('/gamemode creative');
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.warn('[SKILLS] Could not enable creative mode:', error.message);
            }

            const verticalDiff = Math.abs(targetPos.y - currentPos.y);
            const shouldFly = verticalDiff > 1 || targetPos.y > currentPos.y + 1;
            
            // In creative mode during tasks, always assume we should fly for vertical movement
            const isCreativeTask = bot.game.gameMode === 1 && behaviorState.isExecutingTask;
            const currentlyFlying = isFlying();
            
            if (shouldFly || currentlyFlying || (isCreativeTask && verticalDiff > 0.5)) {
                const flightStatus = currentlyFlying ? 'flying' : (isCreativeTask ? 'creative' : 'ground');
                console.log(`[SKILLS] Moving to position (vertical diff: ${verticalDiff.toFixed(1)}, status: ${flightStatus})`);
                
                behaviorState.isMoving = true;
                
                // Cancel any existing goal first to avoid "goal was changed" errors
                try {
                    bot.pathfinder.setGoal(null);
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    // Ignore errors when clearing goal
                }
                
                // For flying in creative mode, use pathfinder which should handle flying
                // But we need to ensure the bot is actually flying
                const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, tolerance);
                
                try {
                    // Look at target first to orient the bot
                    bot.lookAt(targetPos);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Use pathfinder - in creative mode it should fly
                    // Set goal and wait for completion
                    bot.pathfinder.setGoal(goal);
                    
                    // Wait for pathfinder to complete or timeout
                    let attempts = 0;
                    const maxWaitTime = 10000; // 10 seconds max
                    const checkInterval = 200; // Check every 200ms
                    
                    while (bot.pathfinder.isMoving() && attempts * checkInterval < maxWaitTime) {
                        await new Promise(resolve => setTimeout(resolve, checkInterval));
                        attempts++;
                    }
                    
                    // If still moving, cancel and try direct approach
                    if (bot.pathfinder.isMoving()) {
                        bot.pathfinder.setGoal(null);
                        throw new Error('Pathfinder timeout');
                    }
                    
                    // Verify we reached the target
                    const finalDistance = bot.entity.position.distanceTo(targetPos);
                    if (finalDistance > tolerance) {
                        console.warn(`[SKILLS] Pathfinder stopped ${finalDistance.toFixed(1)} blocks from target, trying direct approach`);
                        
                        // If pathfinder didn't get close enough, try direct movement
                        // Use flight-aware jump control to avoid double-tap issues
                        const maxAttempts = 15;
                        for (let attempt = 0; attempt < maxAttempts; attempt++) {
                            const current = bot.entity.position;
                            const remaining = targetPos.minus(current);
                            const remainingDist = Math.sqrt(
                                remaining.x * remaining.x +
                                remaining.y * remaining.y +
                                remaining.z * remaining.z
                            );
                            
                            // If we've reached the target, stop all movement including jumps
                            if (remainingDist <= tolerance) {
                                // Release jump if still holding
                                if (behaviorState.isJumping) {
                                    bot.setControlState('jump', false);
                                    behaviorState.isJumping = false;
                                }
                                break;
                            }
                            
                            // Check work center constraint if set
                            if (behaviorState.workCenter) {
                                const distFromCenter = current.distanceTo(behaviorState.workCenter);
                                if (distFromCenter > behaviorState.maxWorkDistance) {
                                    // Too far from work center, move back towards center first
                                    console.log(`[SKILLS] Too far from work center (${distFromCenter.toFixed(1)}), moving back...`);
                                    const direction = current.minus(behaviorState.workCenter);
                                    const directionLength = Math.sqrt(
                                        direction.x * direction.x +
                                        direction.y * direction.y +
                                        direction.z * direction.z
                                    );
                                    if (directionLength > 0) {
                                        const normalizedDir = new Vec3(
                                            direction.x / directionLength,
                                            direction.y / directionLength,
                                            direction.z / directionLength
                                        );
                                        const backToCenter = behaviorState.workCenter.plus(
                                            normalizedDir.scaled(behaviorState.maxWorkDistance * 0.8)
                                        );
                                        targetPos = backToCenter;
                                        break; // Exit loop and use pathfinder to go back
                                    }
                                }
                            }
                            
                            // Move directly towards target - use smooth movement
                            bot.lookAt(targetPos);
                            
                            // Calculate direction in bot's local coordinate system
                            const yaw = bot.entity.yaw;
                            const pitch = bot.entity.pitch;
                            
                            // Convert world direction to local movement
                            const forwardX = -Math.sin(yaw);
                            const forwardZ = Math.cos(yaw);
                            const rightX = Math.cos(yaw);
                            const rightZ = Math.sin(yaw);
                            
                            // Project remaining vector onto forward/right axes
                            const forwardComponent = remaining.x * forwardX + remaining.z * forwardZ;
                            const rightComponent = remaining.x * rightX + remaining.z * rightZ;
                            
                            // Use smooth control states (avoid jump/sneak for vertical movement)
                            // In creative mode, looking up/down while moving forward handles vertical movement
                            if (Math.abs(forwardComponent) > 0.1) {
                                if (forwardComponent > 0) {
                                    bot.setControlState('forward', true);
                                    bot.setControlState('back', false);
                                } else {
                                    bot.setControlState('back', true);
                                    bot.setControlState('forward', false);
                                }
                            } else {
                                bot.setControlState('forward', false);
                                bot.setControlState('back', false);
                            }
                            
                            if (Math.abs(rightComponent) > 0.1) {
                                if (rightComponent > 0) {
                                    bot.setControlState('right', true);
                                    bot.setControlState('left', false);
                                } else {
                                    bot.setControlState('left', true);
                                    bot.setControlState('right', false);
                                }
                            } else {
                                bot.setControlState('left', false);
                                bot.setControlState('right', false);
                            }
                            
                            // For vertical movement, use flight-aware jump control
                            const verticalNeeded = remaining.y;
                            if (Math.abs(verticalNeeded) > 0.2) {
                                if (verticalNeeded > 0) {
                                    // Need to go up - use jump with duration based on distance
                                    const verticalDistance = Math.abs(verticalNeeded);
                                    // Long press for longer distances (>2 blocks: 800ms), short press for short distances (300ms)
                                    const jumpDuration = verticalDistance > 2 ? 800 : 300;
                                    
                                    // Check if we can jump (respects flight interval of 3 seconds)
                                    const canJump = await pressJump(jumpDuration, false);
                                    
                                    if (!canJump) {
                                        // If we can't jump yet (due to interval), adjust pitch to maintain altitude
                                        // This helps maintain position while waiting
                                        const flying = isFlying();
                                        if (flying) {
                                            bot.look(bot.entity.yaw, -Math.PI / 4, true);
                                        }
                                        // Skip this iteration to wait for interval
                                        await new Promise(resolve => setTimeout(resolve, 200));
                                        continue;
                                    }
                                } else {
                                    // Need to go down - use sneak or adjust pitch
                                    bot.setControlState('sneak', true);
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                    bot.setControlState('sneak', false);
                                }
                            } else {
                                // No significant vertical movement needed, maintain current pitch
                                // Don't change pitch if we're close to target
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 150));
                            
                            // Release all controls
                            bot.setControlState('forward', false);
                            bot.setControlState('back', false);
                            bot.setControlState('left', false);
                            bot.setControlState('right', false);
                        }
                    }
                    
                    behaviorState.isMoving = false;
                    return bot.entity.position.distanceTo(targetPos) <= tolerance;
                } catch (error) {
                    console.error(`[SKILLS] Error during flying movement: ${error.message}`);
                    behaviorState.isMoving = false;
                    return false;
                }
            } else {
                // Normal ground movement
                console.log(`[SKILLS] Moving to (${Math.floor(targetPos.x)}, ${Math.floor(targetPos.y)}, ${Math.floor(targetPos.z)}) [distance: ${distance.toFixed(1)}]`);
                
                // Reset velocity before movement
                this.resetVelocity();
                
                behaviorState.isMoving = true;
                const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, tolerance);
                await bot.pathfinder.goto(goal);
                
                // Reset velocity after movement
                await new Promise(resolve => setTimeout(resolve, 100));
                this.resetVelocity();
                
                behaviorState.isMoving = false;
                return true;
            }
        } catch (error) {
            console.error(`[SKILLS] Error moving to position: ${error.message}`);
            behaviorState.isMoving = false;
            return false;
        }
    },

    /**
     * Replaces a block at target position using /setblock command
     * Directly replaces blocks including air - no adjacency requirements
     * @param {Vec3} targetPos - Target position
     * @param {string} blockName - Block name (e.g., 'oak_log', 'spruce_leaves')
     * @param {number} maxPlaceDistance - Maximum placement distance (not used, kept for compatibility)
     * @returns {Promise<boolean>} Success status
     */
    async placeBlockAt(targetPos, blockName, maxPlaceDistance = 5) {
        try {
            const targetBlock = bot.blockAt(targetPos);
            
            // If block is already correct, skip
            if (targetBlock && targetBlock.name === blockName) {
                return true;
            }
            
            // Convert block name to Minecraft format (e.g., 'oak_log' -> 'minecraft:oak_log')
            const minecraftBlockName = blockName.startsWith('minecraft:') ? blockName : `minecraft:${blockName}`;
            
            // Use /setblock command to directly replace the block (including air)
            // Format: /setblock <x> <y> <z> <block> replace
            const x = Math.floor(targetPos.x);
            const y = Math.floor(targetPos.y);
            const z = Math.floor(targetPos.z);
            
            // Only log if not in silent mode
            if (!BEHAVIOR_CONFIG.silentMode) {
                console.log(`[SKILLS] Replacing block at (${x}, ${y}, ${z}) with ${minecraftBlockName} using /setblock command`);
            }
            
            // Execute /setblock command (server will show feedback unless sendCommandFeedback is false)
            bot.chat(`/setblock ${x} ${y} ${z} ${minecraftBlockName} replace`);
            
            // Wait for block update
            await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // Verify placement
                    const placedBlock = bot.blockAt(targetPos);
                    if (placedBlock && placedBlock.name === blockName) {
                console.log(`[SKILLS] Successfully replaced block with ${blockName} at ${targetPos.toString()}`);
                        return true;
                    } else {
                console.warn(`[SKILLS] Replacement verification failed - expected ${blockName}, got ${placedBlock?.name || 'null'}`);
                // Try one more time after a delay
                await new Promise(resolve => setTimeout(resolve, 200));
                const retryCheck = bot.blockAt(targetPos);
                if (retryCheck && retryCheck.name === blockName) {
                    console.log(`[SKILLS] Successfully replaced block with ${blockName} at ${targetPos.toString()} (retry check)`);
                    return true;
                }
            return false;
            }
        } catch (error) {
            console.error(`[SKILLS] Error replacing block ${blockName} at ${targetPos.toString()}: ${error.message}`);
            return false;
        }
    },

    /**
     * Reset bot velocity to zero (clear inertia)
     * Critical for stable movement in creative mode
     */
    resetVelocity() {
        try {
            if (bot.entity && bot.entity.velocity) {
                bot.entity.velocity.set(0, 0, 0);
                console.log('[SKILLS] Velocity reset (inertia cleared)');
            }
        } catch (error) {
            console.warn(`[SKILLS] Could not reset velocity: ${error.message}`);
        }
    },

    /**
     * Get discrete observation positions around a center (4 cardinal directions)
     * Uses discrete positions instead of continuous circle to avoid sync issues
     * @param {Vec3} center - Center position
     * @param {number} radius - Distance from center (default: 3)
     * @param {number} directionIndex - 0=North, 1=East, 2=South, 3=West
     * @param {number} heightOffset - Height offset from center
     * @returns {Vec3} Observation position
     */
    getDiscreteObservationPosition(center, radius = 3, directionIndex = 0, heightOffset = 0) {
        // Discrete directions: North, East, South, West
        const directions = [
            new Vec3(0, 0, -radius),  // North
            new Vec3(radius, 0, 0),   // East
            new Vec3(0, 0, radius),   // South
            new Vec3(-radius, 0, 0)   // West
        ];
        
        const direction = directions[directionIndex % 4];
        const observationPos = center.plus(direction);
        observationPos.y = center.y + heightOffset;
        
        return observationPos;
    },

    /**
     * Moves bot to a discrete observation position around center
     * Uses discrete positions instead of continuous circle to avoid sync issues
     * @param {Vec3} center - Center position
     * @param {number} radius - Distance from center (default: 3)
     * @param {number} directionIndex - 0=North, 1=East, 2=South, 3=West
     * @param {number} heightOffset - Height offset from center
     * @returns {Promise<Vec3>} Final position reached
     */
    async moveToDiscretePosition(center, radius = 3, directionIndex = 0, heightOffset = 0) {
        const targetPos = this.getDiscreteObservationPosition(center, radius, directionIndex, heightOffset);
        
        // Check work center constraint if set
        if (behaviorState.workCenter) {
            const distFromWorkCenter = targetPos.distanceTo(behaviorState.workCenter);
            
            // If too far from work center, adjust position
            if (distFromWorkCenter > behaviorState.maxWorkDistance) {
                const direction = targetPos.minus(behaviorState.workCenter);
                const directionLength = Math.sqrt(
                    direction.x * direction.x +
                    direction.y * direction.y +
                    direction.z * direction.z
                );
                if (directionLength > 0) {
                    const normalizedDir = new Vec3(
                        direction.x / directionLength,
                        direction.y / directionLength,
                        direction.z / directionLength
                    );
                    const constrainedPos = behaviorState.workCenter.plus(
                        normalizedDir.scaled(behaviorState.maxWorkDistance * 0.9)
                    );
                    targetPos.x = constrainedPos.x;
                    targetPos.y = constrainedPos.y;
                    targetPos.z = constrainedPos.z;
                }
            }
        }
        
        // Reset velocity before moving
        this.resetVelocity();
        
        // Move to position
        await this.moveToPosition(targetPos, 0.5);
        
        // Reset velocity after moving to eliminate inertia
        await new Promise(resolve => setTimeout(resolve, 100));
        this.resetVelocity();
        
        return targetPos;
    },

    /**
     * Moves bot in a circle around a center point, can fly to different heights
     * DEPRECATED: Use moveToDiscretePosition instead for better stability
     * @param {Vec3} center - Center position
     * @param {number} radius - Circle radius (default: 3)
     * @param {number} angle - Current angle in radians
     * @param {number} heightOffset - Height offset from center (default: 0, can be negative for below)
     * @returns {Promise<Vec3>} Next position on the circle
     */
    async moveAroundCenter(center, radius = 3, angle = 0, heightOffset = 0) {
        let nextX = center.x + Math.cos(angle) * radius;
        let nextZ = center.z + Math.sin(angle) * radius;
        let nextY = center.y + heightOffset;
        
        // Check work center constraint if set
        if (behaviorState.workCenter) {
            const candidatePos = new Vec3(nextX, nextY, nextZ);
            const distFromWorkCenter = candidatePos.distanceTo(behaviorState.workCenter);
            
            // If too far from work center, adjust position to stay within bounds
            if (distFromWorkCenter > behaviorState.maxWorkDistance) {
                const direction = candidatePos.minus(behaviorState.workCenter);
                const directionLength = Math.sqrt(
                    direction.x * direction.x +
                    direction.y * direction.y +
                    direction.z * direction.z
                );
                if (directionLength > 0) {
                    const normalizedDir = new Vec3(
                        direction.x / directionLength,
                        direction.y / directionLength,
                        direction.z / directionLength
                    );
                    const constrainedPos = behaviorState.workCenter.plus(
                        normalizedDir.scaled(behaviorState.maxWorkDistance * 0.9)
                    );
                    nextX = constrainedPos.x;
                    nextY = constrainedPos.y;
                    nextZ = constrainedPos.z;
                    console.log(`[SKILLS] Adjusted position to stay within work center bounds`);
                }
            }
            
            // If too close to work center, move away slightly
            if (distFromWorkCenter < behaviorState.minWorkDistance) {
                const direction = candidatePos.minus(behaviorState.workCenter);
                const directionLength = Math.sqrt(
                    direction.x * direction.x +
                    direction.y * direction.y +
                    direction.z * direction.z
                );
                if (directionLength > 0) {
                    const normalizedDir = new Vec3(
                        direction.x / directionLength,
                        direction.y / directionLength,
                        direction.z / directionLength
                    );
                    const adjustedPos = behaviorState.workCenter.plus(
                        normalizedDir.scaled(behaviorState.minWorkDistance * 1.2)
                    );
                    nextX = adjustedPos.x;
                    nextY = adjustedPos.y;
                    nextZ = adjustedPos.z;
                }
            }
        }
        
        const nextPos = new Vec3(nextX, nextY, nextZ);
        await this.moveToPosition(nextPos, 1);
        
        return nextPos;
    },

    /**
     * Loads blueprint from JSON file
     * Supports both JSON format and JavaScript code format
     * @param {string} blueprintPath - Path to blueprint file (default: 'blueprint.json')
     * @returns {Promise<Array>} Blueprint array with Vec3 positions, or null if loading failed
     */
    async loadBlueprint(blueprintPath = null) {
        try {
            const filePath = blueprintPath || process.env.BLUEPRINT_FILE || 'blueprint.json';
            const fullPath = path.join(__dirname, filePath);
            
            if (!fs.existsSync(fullPath)) {
                console.warn(`[SKILLS] Blueprint file not found: ${fullPath}`);
                console.warn(`[SKILLS] Falling back to hardcoded blueprint`);
                return null;
            }
            
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            
            // Try to parse as JSON first
            try {
                const jsonData = JSON.parse(fileContent);
                
                // Convert JSON format to Vec3 format
                if (jsonData.blocks && Array.isArray(jsonData.blocks)) {
                    console.log(`[SKILLS] Loaded blueprint from ${filePath}: ${jsonData.name || 'Unknown'} (${jsonData.total_blocks || jsonData.blocks.length} blocks)`);
                    return jsonData.blocks.map(entry => ({
                        block: entry.block,
                        pos: new Vec3(entry.pos.x, entry.pos.y, entry.pos.z)
                    }));
                }
            } catch (jsonError) {
                // If JSON parsing fails, try to parse as JavaScript code
                console.log(`[SKILLS] Attempting to parse as JavaScript code format...`);
                
                // Extract blueprint array using regex
                const blueprintMatch = fileContent.match(/const\s+blueprint\s*=\s*\[([\s\S]*?)\];/);
                if (blueprintMatch) {
                    // Use regex to extract entries safely (no eval)
                    const entries = [];
                    const entryPattern = /\{\s*block:\s*['"]([^'"]+)['"],\s*pos:\s*new\s+Vec3\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)\s*\}/g;
                    let match;
                    
                    while ((match = entryPattern.exec(fileContent)) !== null) {
                        entries.push({
                            block: match[1],
                            pos: new Vec3(parseInt(match[2]), parseInt(match[3]), parseInt(match[4]))
                        });
                    }
                    
                    if (entries.length > 0) {
                        console.log(`[SKILLS] Loaded blueprint from ${filePath}: ${entries.length} blocks (JavaScript format)`);
                        return entries;
                    }
                }
            }
            
            console.warn(`[SKILLS] Could not parse blueprint file: ${filePath}`);
            return null;
            
        } catch (error) {
            console.error(`[SKILLS] Error loading blueprint: ${error.message}`);
            return null;
        }
    },

    /**
     * Builds a Christmas tree at the given origin position
     * Uses teleportation-based deterministic placement (Voxel-Aligned Teleport Protocol)
     * Loads blueprint from file if available, otherwise uses hardcoded blueprint
     * @param {Vec3} origin - Base position for the tree
     * @returns {Promise<string>} Success message
     */
    async buildTree(origin) {
        try {
            // Round coordinates to integers (Minecraft uses integer coordinates)
            const baseX = Math.floor(origin.x);
            const baseY = Math.floor(origin.y);
            const baseZ = Math.floor(origin.z);
            const center = new Vec3(baseX, baseY, baseZ);
            
            console.log(`[SKILLS] Building Christmas tree at (${baseX}, ${baseY}, ${baseZ}) using teleportation protocol`);
            bot.chat(`Building Christmas tree at (${baseX}, ${baseY}, ${baseZ})...`);
            
            // CRITICAL: Completely lock behavior system to prevent interference
            const wasBehaviorEnabled = BEHAVIOR_CONFIG.enabled;
            BEHAVIOR_CONFIG.enabled = false;
            stopNaturalBehavior(); // Stop all behavior loops
            
            // Stop pathfinder completely
            try {
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
            } catch (error) {
                console.warn('[SKILLS] Error stopping pathfinder:', error.message);
            }
            
            // Disable player following during building
            const wasFollowing = behaviorState.isFollowing;
            const wasFollowingPlayer = behaviorState.followingPlayer;
            behaviorState.isFollowing = false;
            behaviorState.followingPlayer = null;
            
            // Set task execution flag (will disable jump control after flying activation)
            behaviorState.isMoving = true;
            
            // Ensure creative mode for teleportation and building
            // Block breaking is still disabled via code protection (bot.dig override)
            try {
                bot.chat('/gamemode creative');
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log('[SKILLS] Creative mode enabled - block breaking still disabled via code protection');
            } catch (error) {
                console.warn('[SKILLS] Could not enable creative mode:', error.message);
            }
            
            // CRITICAL: Use aggressive position correction instead of relying on flight commands
            // Since flight commands may not work, we'll continuously monitor and correct position
            console.log('[SKILLS] Starting aggressive position maintenance (anti-gravity mode)...');
            
            // Track expected height for each block placement
            let expectedHeight = baseY + 1; // Start at base + 1
            let lastTeleportPos = null;
            
            // Start a continuous position correction loop (very frequent)
            let flightMaintenanceInterval = null;
            
            // Function to aggressively maintain position (anti-gravity)
            const maintainPosition = async () => {
                if (!behaviorState.isExecutingTask) return;
                
                try {
                    const currentPos = bot.entity.position;
                    const currentY = currentPos.y;
                    
                    // If we have a last teleport position, use it as reference
                    if (lastTeleportPos) {
                        const expectedY = lastTeleportPos.y;
                        
                        // If we're falling (Y decreased), immediately correct (silent mode)
                        if (currentY < expectedY - 0.2) {
                            // Re-teleport to maintain height (silent - no console output)
                            bot.chat(`/tp ${bot.username} ${Math.floor(lastTeleportPos.x)} ${Math.floor(expectedY)} ${Math.floor(lastTeleportPos.z)}`);
                            await new Promise(resolve => setTimeout(resolve, 10));
                        }
                    } else {
                        // If no reference, check if we're below base level (silent mode)
                        if (currentY < baseY - 1) {
                            const correctPos = new Vec3(currentPos.x, baseY + 5, currentPos.z);
                            bot.chat(`/tp ${bot.username} ${Math.floor(correctPos.x)} ${Math.floor(correctPos.y)} ${Math.floor(correctPos.z)}`);
                            await new Promise(resolve => setTimeout(resolve, 10));
                        }
                    }
                    
                    // Try flight commands silently (but don't rely on them)
                    // Note: These commands may produce output, but we minimize them
                    bot.chat('/fly');
                    bot.chat('/ability @s mayfly true');
                } catch (error) {
                    // Ignore errors, continue maintaining
                }
            };
            
            // Start very frequent position maintenance (every 5ms - extremely aggressive)
            flightMaintenanceInterval = setInterval(() => {
                if (behaviorState.isExecutingTask) {
                    maintainPosition().catch(err => {
                        // Silently ignore errors
                    });
                }
            }, 5); // Check every 5ms (200 times per second)
            
            // Silent mode - no console output for position maintenance
            
            // Now set task execution flag to prevent further jumps during building
            behaviorState.isExecutingTask = true;
            
            // Load blueprint from file, fallback to hardcoded if file not found
            let blueprint = await this.loadBlueprint();
            
            // Fallback to hardcoded blueprint if file loading failed
            if (!blueprint) {
                console.log('[SKILLS] Using hardcoded blueprint (fallback)');
                // Blueprint: Array of {block, relativePos} objects
                // Converted from litematic file: 17353.litematic (Christmas_tree)
                // Total blocks: 603
                blueprint = [
                { block: 'grass_block', pos: new Vec3(0, 0, 0) },
                { block: 'grass_block', pos: new Vec3(1, 0, 0) },
                { block: 'grass_block', pos: new Vec3(2, 0, 0) },
                { block: 'red_wool', pos: new Vec3(3, 0, 0) },
                { block: 'red_wool', pos: new Vec3(4, 0, 0) },
                { block: 'red_wool', pos: new Vec3(5, 0, 0) },
                { block: 'red_wool', pos: new Vec3(6, 0, 0) },
                { block: 'red_wool', pos: new Vec3(7, 0, 0) },
                { block: 'grass_block', pos: new Vec3(8, 0, 0) },
                { block: 'grass_block', pos: new Vec3(9, 0, 0) },
                { block: 'grass_block', pos: new Vec3(10, 0, 0) },
                { block: 'grass_block', pos: new Vec3(0, 0, 1) },
                { block: 'red_wool', pos: new Vec3(1, 0, 1) },
                { block: 'red_wool', pos: new Vec3(2, 0, 1) },
                { block: 'red_wool', pos: new Vec3(3, 0, 1) },
                { block: 'red_wool', pos: new Vec3(4, 0, 1) },
                { block: 'red_wool', pos: new Vec3(5, 0, 1) },
                { block: 'red_wool', pos: new Vec3(6, 0, 1) },
                { block: 'red_wool', pos: new Vec3(7, 0, 1) },
                { block: 'red_wool', pos: new Vec3(8, 0, 1) },
                { block: 'red_wool', pos: new Vec3(9, 0, 1) },
                { block: 'grass_block', pos: new Vec3(10, 0, 1) },
                { block: 'grass_block', pos: new Vec3(0, 0, 2) },
                { block: 'red_wool', pos: new Vec3(1, 0, 2) },
                { block: 'red_wool', pos: new Vec3(2, 0, 2) },
                { block: 'red_wool', pos: new Vec3(3, 0, 2) },
                { block: 'red_wool', pos: new Vec3(4, 0, 2) },
                { block: 'red_wool', pos: new Vec3(5, 0, 2) },
                { block: 'red_wool', pos: new Vec3(6, 0, 2) },
                { block: 'red_wool', pos: new Vec3(7, 0, 2) },
                { block: 'red_wool', pos: new Vec3(8, 0, 2) },
                { block: 'red_wool', pos: new Vec3(9, 0, 2) },
                { block: 'grass_block', pos: new Vec3(10, 0, 2) },
                { block: 'red_wool', pos: new Vec3(0, 0, 3) },
                { block: 'red_wool', pos: new Vec3(1, 0, 3) },
                { block: 'red_wool', pos: new Vec3(2, 0, 3) },
                { block: 'red_wool', pos: new Vec3(3, 0, 3) },
                { block: 'red_wool', pos: new Vec3(4, 0, 3) },
                { block: 'red_wool', pos: new Vec3(5, 0, 3) },
                { block: 'red_wool', pos: new Vec3(6, 0, 3) },
                { block: 'red_wool', pos: new Vec3(7, 0, 3) },
                { block: 'red_wool', pos: new Vec3(8, 0, 3) },
                { block: 'red_wool', pos: new Vec3(9, 0, 3) },
                { block: 'red_wool', pos: new Vec3(10, 0, 3) },
                { block: 'red_wool', pos: new Vec3(0, 0, 4) },
                { block: 'red_wool', pos: new Vec3(1, 0, 4) },
                { block: 'red_wool', pos: new Vec3(2, 0, 4) },
                { block: 'red_wool', pos: new Vec3(3, 0, 4) },
                { block: 'red_wool', pos: new Vec3(4, 0, 4) },
                { block: 'red_wool', pos: new Vec3(5, 0, 4) },
                { block: 'red_wool', pos: new Vec3(6, 0, 4) },
                { block: 'red_wool', pos: new Vec3(7, 0, 4) },
                { block: 'red_wool', pos: new Vec3(8, 0, 4) },
                { block: 'red_wool', pos: new Vec3(9, 0, 4) },
                { block: 'red_wool', pos: new Vec3(10, 0, 4) },
                { block: 'red_wool', pos: new Vec3(0, 0, 5) },
                { block: 'red_wool', pos: new Vec3(1, 0, 5) },
                { block: 'red_wool', pos: new Vec3(2, 0, 5) },
                { block: 'red_wool', pos: new Vec3(3, 0, 5) },
                { block: 'red_wool', pos: new Vec3(4, 0, 5) },
                { block: 'red_wool', pos: new Vec3(5, 0, 5) },
                { block: 'red_wool', pos: new Vec3(6, 0, 5) },
                { block: 'red_wool', pos: new Vec3(7, 0, 5) },
                { block: 'red_wool', pos: new Vec3(8, 0, 5) },
                { block: 'red_wool', pos: new Vec3(9, 0, 5) },
                { block: 'red_wool', pos: new Vec3(10, 0, 5) },
                { block: 'red_wool', pos: new Vec3(0, 0, 6) },
                { block: 'red_wool', pos: new Vec3(1, 0, 6) },
                { block: 'red_wool', pos: new Vec3(2, 0, 6) },
                { block: 'red_wool', pos: new Vec3(3, 0, 6) },
                { block: 'red_wool', pos: new Vec3(4, 0, 6) },
                { block: 'red_wool', pos: new Vec3(5, 0, 6) },
                { block: 'red_wool', pos: new Vec3(6, 0, 6) },
                { block: 'red_wool', pos: new Vec3(7, 0, 6) },
                { block: 'red_wool', pos: new Vec3(8, 0, 6) },
                { block: 'red_wool', pos: new Vec3(9, 0, 6) },
                { block: 'red_wool', pos: new Vec3(10, 0, 6) },
                { block: 'red_wool', pos: new Vec3(0, 0, 7) },
                { block: 'red_wool', pos: new Vec3(1, 0, 7) },
                { block: 'red_wool', pos: new Vec3(2, 0, 7) },
                { block: 'red_wool', pos: new Vec3(3, 0, 7) },
                { block: 'red_wool', pos: new Vec3(4, 0, 7) },
                { block: 'red_wool', pos: new Vec3(5, 0, 7) },
                { block: 'red_wool', pos: new Vec3(6, 0, 7) },
                { block: 'red_wool', pos: new Vec3(7, 0, 7) },
                { block: 'red_wool', pos: new Vec3(8, 0, 7) },
                { block: 'red_wool', pos: new Vec3(9, 0, 7) },
                { block: 'red_wool', pos: new Vec3(10, 0, 7) },
                { block: 'grass_block', pos: new Vec3(0, 0, 8) },
                { block: 'red_wool', pos: new Vec3(1, 0, 8) },
                { block: 'red_wool', pos: new Vec3(2, 0, 8) },
                { block: 'red_wool', pos: new Vec3(3, 0, 8) },
                { block: 'red_wool', pos: new Vec3(4, 0, 8) },
                { block: 'red_wool', pos: new Vec3(5, 0, 8) },
                { block: 'red_wool', pos: new Vec3(6, 0, 8) },
                { block: 'red_wool', pos: new Vec3(7, 0, 8) },
                { block: 'red_wool', pos: new Vec3(8, 0, 8) },
                { block: 'red_wool', pos: new Vec3(9, 0, 8) },
                { block: 'grass_block', pos: new Vec3(10, 0, 8) },
                { block: 'grass_block', pos: new Vec3(0, 0, 9) },
                { block: 'red_wool', pos: new Vec3(1, 0, 9) },
                { block: 'red_wool', pos: new Vec3(2, 0, 9) },
                { block: 'red_wool', pos: new Vec3(3, 0, 9) },
                { block: 'red_wool', pos: new Vec3(4, 0, 9) },
                { block: 'red_wool', pos: new Vec3(5, 0, 9) },
                { block: 'red_wool', pos: new Vec3(6, 0, 9) },
                { block: 'red_wool', pos: new Vec3(7, 0, 9) },
                { block: 'red_wool', pos: new Vec3(8, 0, 9) },
                { block: 'red_wool', pos: new Vec3(9, 0, 9) },
                { block: 'grass_block', pos: new Vec3(10, 0, 9) },
                { block: 'grass_block', pos: new Vec3(0, 0, 10) },
                { block: 'grass_block', pos: new Vec3(1, 0, 10) },
                { block: 'grass_block', pos: new Vec3(2, 0, 10) },
                { block: 'red_wool', pos: new Vec3(3, 0, 10) },
                { block: 'red_wool', pos: new Vec3(4, 0, 10) },
                { block: 'red_wool', pos: new Vec3(5, 0, 10) },
                { block: 'red_wool', pos: new Vec3(6, 0, 10) },
                { block: 'red_wool', pos: new Vec3(7, 0, 10) },
                { block: 'grass_block', pos: new Vec3(8, 0, 10) },
                { block: 'grass_block', pos: new Vec3(9, 0, 10) },
                { block: 'grass_block', pos: new Vec3(10, 0, 10) },
                { block: 'red_carpet', pos: new Vec3(3, 1, 0) },
                { block: 'red_carpet', pos: new Vec3(5, 1, 0) },
                { block: 'red_carpet', pos: new Vec3(1, 1, 1) },
                { block: 'red_carpet', pos: new Vec3(2, 1, 1) },
                { block: 'red_carpet', pos: new Vec3(4, 1, 1) },
                { block: 'light_blue_shulker_box', pos: new Vec3(5, 1, 1) },
                { block: 'red_carpet', pos: new Vec3(7, 1, 1) },
                { block: 'lime_shulker_box', pos: new Vec3(2, 1, 2) },
                { block: 'red_carpet', pos: new Vec3(6, 1, 2) },
                { block: 'orange_shulker_box', pos: new Vec3(8, 1, 2) },
                { block: 'red_carpet', pos: new Vec3(1, 1, 3) },
                { block: 'red_carpet', pos: new Vec3(4, 1, 3) },
                { block: 'spruce_wood', pos: new Vec3(5, 1, 3) },
                { block: 'red_carpet', pos: new Vec3(6, 1, 3) },
                { block: 'red_carpet', pos: new Vec3(8, 1, 3) },
                { block: 'red_carpet', pos: new Vec3(0, 1, 4) },
                { block: 'spruce_wood', pos: new Vec3(4, 1, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 1, 4) },
                { block: 'spruce_wood', pos: new Vec3(6, 1, 4) },
                { block: 'dark_oak_fence', pos: new Vec3(7, 1, 4) },
                { block: 'red_carpet', pos: new Vec3(9, 1, 4) },
                { block: 'red_carpet', pos: new Vec3(10, 1, 4) },
                { block: 'magenta_shulker_box', pos: new Vec3(1, 1, 5) },
                { block: 'spruce_wood', pos: new Vec3(3, 1, 5) },
                { block: 'spruce_log', pos: new Vec3(4, 1, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 1, 5) },
                { block: 'spruce_log', pos: new Vec3(6, 1, 5) },
                { block: 'spruce_wood', pos: new Vec3(7, 1, 5) },
                { block: 'magenta_shulker_box', pos: new Vec3(9, 1, 5) },
                { block: 'red_carpet', pos: new Vec3(0, 1, 6) },
                { block: 'spruce_wood', pos: new Vec3(4, 1, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 1, 6) },
                { block: 'spruce_wood', pos: new Vec3(6, 1, 6) },
                { block: 'red_carpet', pos: new Vec3(8, 1, 6) },
                { block: 'red_carpet', pos: new Vec3(10, 1, 6) },
                { block: 'red_carpet', pos: new Vec3(0, 1, 7) },
                { block: 'red_carpet', pos: new Vec3(1, 1, 7) },
                { block: 'red_carpet', pos: new Vec3(3, 1, 7) },
                { block: 'spruce_wood', pos: new Vec3(5, 1, 7) },
                { block: 'red_carpet', pos: new Vec3(6, 1, 7) },
                { block: 'orange_shulker_box', pos: new Vec3(2, 1, 8) },
                { block: 'red_carpet', pos: new Vec3(6, 1, 8) },
                { block: 'red_carpet', pos: new Vec3(7, 1, 8) },
                { block: 'lime_shulker_box', pos: new Vec3(8, 1, 8) },
                { block: 'red_carpet', pos: new Vec3(9, 1, 8) },
                { block: 'red_carpet', pos: new Vec3(3, 1, 9) },
                { block: 'light_blue_shulker_box', pos: new Vec3(5, 1, 9) },
                { block: 'red_carpet', pos: new Vec3(7, 1, 9) },
                { block: 'red_carpet', pos: new Vec3(3, 1, 10) },
                { block: 'red_carpet', pos: new Vec3(4, 1, 10) },
                { block: 'red_carpet', pos: new Vec3(6, 1, 10) },
                { block: 'oak_button', pos: new Vec3(5, 2, 1) },
                { block: 'oak_button', pos: new Vec3(2, 2, 2) },
                { block: 'oak_button', pos: new Vec3(8, 2, 2) },
                { block: 'snow', pos: new Vec3(5, 2, 3) },
                { block: 'spruce_wood', pos: new Vec3(4, 2, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 2, 4) },
                { block: 'spruce_wood', pos: new Vec3(6, 2, 4) },
                { block: 'oak_button', pos: new Vec3(1, 2, 5) },
                { block: 'snow', pos: new Vec3(3, 2, 5) },
                { block: 'spruce_log', pos: new Vec3(4, 2, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 2, 5) },
                { block: 'spruce_log', pos: new Vec3(6, 2, 5) },
                { block: 'snow', pos: new Vec3(7, 2, 5) },
                { block: 'oak_button', pos: new Vec3(9, 2, 5) },
                { block: 'spruce_wood', pos: new Vec3(4, 2, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 2, 6) },
                { block: 'spruce_wood', pos: new Vec3(6, 2, 6) },
                { block: 'oak_button', pos: new Vec3(2, 2, 8) },
                { block: 'oak_button', pos: new Vec3(8, 2, 8) },
                { block: 'oak_button', pos: new Vec3(5, 2, 9) },
                { block: 'spruce_log', pos: new Vec3(5, 3, 4) },
                { block: 'purple_glazed_terracotta', pos: new Vec3(9, 3, 4) },
                { block: 'spruce_log', pos: new Vec3(4, 3, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 3, 5) },
                { block: 'spruce_log', pos: new Vec3(6, 3, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 3, 6) },
                { block: 'spruce_leaves', pos: new Vec3(8, 4, 3) },
                { block: 'spruce_log', pos: new Vec3(5, 4, 4) },
                { block: 'spruce_leaves', pos: new Vec3(8, 4, 4) },
                { block: 'lantern', pos: new Vec3(9, 4, 4) },
                { block: 'spruce_log', pos: new Vec3(4, 4, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 4, 5) },
                { block: 'spruce_log', pos: new Vec3(6, 4, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 4, 5) },
                { block: 'spruce_leaves', pos: new Vec3(8, 4, 5) },
                { block: 'spruce_leaves', pos: new Vec3(9, 4, 5) },
                { block: 'red_glazed_terracotta', pos: new Vec3(1, 4, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 4, 6) },
                { block: 'spruce_leaves', pos: new Vec3(8, 4, 6) },
                { block: 'spruce_leaves', pos: new Vec3(8, 4, 7) },
                { block: 'lime_glazed_terracotta', pos: new Vec3(4, 5, 1) },
                { block: 'spruce_leaves', pos: new Vec3(8, 5, 2) },
                { block: 'spruce_leaves', pos: new Vec3(2, 5, 3) },
                { block: 'spruce_leaves', pos: new Vec3(7, 5, 3) },
                { block: 'spruce_wood', pos: new Vec3(8, 5, 3) },
                { block: 'spruce_leaves', pos: new Vec3(9, 5, 3) },
                { block: 'spruce_leaves', pos: new Vec3(2, 5, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 5, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 5, 4) },
                { block: 'spruce_leaves', pos: new Vec3(7, 5, 4) },
                { block: 'spruce_wood', pos: new Vec3(8, 5, 4) },
                { block: 'dark_oak_fence', pos: new Vec3(9, 5, 4) },
                { block: 'spruce_leaves', pos: new Vec3(10, 5, 4) },
                { block: 'spruce_leaves', pos: new Vec3(1, 5, 5) },
                { block: 'spruce_leaves', pos: new Vec3(2, 5, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 5, 5) },
                { block: 'spruce_log', pos: new Vec3(4, 5, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 5, 5) },
                { block: 'spruce_wood', pos: new Vec3(6, 5, 5) },
                { block: 'spruce_wood', pos: new Vec3(7, 5, 5) },
                { block: 'spruce_wood', pos: new Vec3(8, 5, 5) },
                { block: 'spruce_wood', pos: new Vec3(9, 5, 5) },
                { block: 'spruce_leaves', pos: new Vec3(10, 5, 5) },
                { block: 'lantern', pos: new Vec3(1, 5, 6) },
                { block: 'spruce_leaves', pos: new Vec3(2, 5, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 5, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 5, 6) },
                { block: 'spruce_leaves', pos: new Vec3(7, 5, 6) },
                { block: 'spruce_wood', pos: new Vec3(8, 5, 6) },
                { block: 'spruce_leaves', pos: new Vec3(9, 5, 6) },
                { block: 'spruce_leaves', pos: new Vec3(2, 5, 7) },
                { block: 'spruce_leaves', pos: new Vec3(7, 5, 7) },
                { block: 'spruce_wood', pos: new Vec3(8, 5, 7) },
                { block: 'spruce_leaves', pos: new Vec3(9, 5, 7) },
                { block: 'spruce_leaves', pos: new Vec3(8, 5, 8) },
                { block: 'lantern', pos: new Vec3(4, 6, 1) },
                { block: 'spruce_leaves', pos: new Vec3(5, 6, 1) },
                { block: 'spruce_leaves', pos: new Vec3(2, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(3, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(4, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(5, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(6, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(7, 6, 2) },
                { block: 'spruce_leaves', pos: new Vec3(1, 6, 3) },
                { block: 'spruce_wood', pos: new Vec3(2, 6, 3) },
                { block: 'spruce_leaves', pos: new Vec3(3, 6, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 6, 3) },
                { block: 'spruce_leaves', pos: new Vec3(8, 6, 3) },
                { block: 'spruce_leaves', pos: new Vec3(1, 6, 4) },
                { block: 'spruce_wood', pos: new Vec3(2, 6, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 6, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 6, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 6, 4) },
                { block: 'spruce_leaves', pos: new Vec3(8, 6, 4) },
                { block: 'spruce_leaves', pos: new Vec3(9, 6, 4) },
                { block: 'spruce_leaves', pos: new Vec3(0, 6, 5) },
                { block: 'spruce_wood', pos: new Vec3(1, 6, 5) },
                { block: 'spruce_wood', pos: new Vec3(2, 6, 5) },
                { block: 'spruce_wood', pos: new Vec3(3, 6, 5) },
                { block: 'spruce_wood', pos: new Vec3(4, 6, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 6, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 6, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 6, 5) },
                { block: 'spruce_leaves', pos: new Vec3(8, 6, 5) },
                { block: 'spruce_leaves', pos: new Vec3(9, 6, 5) },
                { block: 'spruce_leaves', pos: new Vec3(0, 6, 6) },
                { block: 'dark_oak_fence', pos: new Vec3(1, 6, 6) },
                { block: 'spruce_wood', pos: new Vec3(2, 6, 6) },
                { block: 'spruce_leaves', pos: new Vec3(3, 6, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 6, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 6, 6) },
                { block: 'spruce_leaves', pos: new Vec3(8, 6, 6) },
                { block: 'spruce_leaves', pos: new Vec3(1, 6, 7) },
                { block: 'spruce_wood', pos: new Vec3(2, 6, 7) },
                { block: 'spruce_leaves', pos: new Vec3(3, 6, 7) },
                { block: 'spruce_leaves', pos: new Vec3(8, 6, 7) },
                { block: 'spruce_leaves', pos: new Vec3(2, 6, 8) },
                { block: 'yellow_glazed_terracotta', pos: new Vec3(6, 6, 9) },
                { block: 'spruce_leaves', pos: new Vec3(4, 7, 0) },
                { block: 'spruce_leaves', pos: new Vec3(5, 7, 0) },
                { block: 'spruce_leaves', pos: new Vec3(3, 7, 1) },
                { block: 'dark_oak_fence', pos: new Vec3(4, 7, 1) },
                { block: 'spruce_wood', pos: new Vec3(5, 7, 1) },
                { block: 'spruce_leaves', pos: new Vec3(6, 7, 1) },
                { block: 'spruce_leaves', pos: new Vec3(7, 7, 1) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 2) },
                { block: 'spruce_wood', pos: new Vec3(3, 7, 2) },
                { block: 'spruce_wood', pos: new Vec3(4, 7, 2) },
                { block: 'spruce_wood', pos: new Vec3(5, 7, 2) },
                { block: 'spruce_wood', pos: new Vec3(6, 7, 2) },
                { block: 'spruce_wood', pos: new Vec3(7, 7, 2) },
                { block: 'spruce_leaves', pos: new Vec3(8, 7, 2) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 3) },
                { block: 'spruce_leaves', pos: new Vec3(3, 7, 3) },
                { block: 'spruce_leaves', pos: new Vec3(4, 7, 3) },
                { block: 'spruce_wood', pos: new Vec3(5, 7, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 7, 3) },
                { block: 'spruce_leaves', pos: new Vec3(7, 7, 3) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 7, 4) },
                { block: 'spruce_wood', pos: new Vec3(5, 7, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 7, 4) },
                { block: 'spruce_leaves', pos: new Vec3(1, 7, 5) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 7, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 7, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 7, 5) },
                { block: 'spruce_leaves', pos: new Vec3(1, 7, 6) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 6) },
                { block: 'spruce_log', pos: new Vec3(5, 7, 6) },
                { block: 'red_glazed_terracotta', pos: new Vec3(8, 7, 6) },
                { block: 'spruce_leaves', pos: new Vec3(2, 7, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 7, 7) },
                { block: 'spruce_leaves', pos: new Vec3(3, 7, 8) },
                { block: 'spruce_leaves', pos: new Vec3(4, 7, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 7, 8) },
                { block: 'spruce_leaves', pos: new Vec3(6, 7, 8) },
                { block: 'spruce_leaves', pos: new Vec3(7, 7, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 7, 9) },
                { block: 'lantern', pos: new Vec3(6, 7, 9) },
                { block: 'spruce_leaves', pos: new Vec3(4, 8, 1) },
                { block: 'spruce_leaves', pos: new Vec3(5, 8, 1) },
                { block: 'spruce_leaves', pos: new Vec3(3, 8, 2) },
                { block: 'spruce_leaves', pos: new Vec3(4, 8, 2) },
                { block: 'spruce_leaves', pos: new Vec3(5, 8, 2) },
                { block: 'spruce_leaves', pos: new Vec3(6, 8, 2) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 2) },
                { block: 'spruce_leaves', pos: new Vec3(5, 8, 3) },
                { block: 'purple_glazed_terracotta', pos: new Vec3(2, 8, 4) },
                { block: 'spruce_leaves', pos: new Vec3(5, 8, 4) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 8, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 8, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 5) },
                { block: 'spruce_leaves', pos: new Vec3(8, 8, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 8, 6) },
                { block: 'spruce_wood', pos: new Vec3(5, 8, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 8, 6) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 6) },
                { block: 'lantern', pos: new Vec3(8, 8, 6) },
                { block: 'spruce_leaves', pos: new Vec3(3, 8, 7) },
                { block: 'spruce_leaves', pos: new Vec3(4, 8, 7) },
                { block: 'spruce_wood', pos: new Vec3(5, 8, 7) },
                { block: 'spruce_leaves', pos: new Vec3(6, 8, 7) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 7) },
                { block: 'spruce_leaves', pos: new Vec3(2, 8, 8) },
                { block: 'spruce_wood', pos: new Vec3(3, 8, 8) },
                { block: 'spruce_wood', pos: new Vec3(4, 8, 8) },
                { block: 'spruce_wood', pos: new Vec3(5, 8, 8) },
                { block: 'spruce_wood', pos: new Vec3(6, 8, 8) },
                { block: 'spruce_wood', pos: new Vec3(7, 8, 8) },
                { block: 'spruce_leaves', pos: new Vec3(8, 8, 8) },
                { block: 'spruce_leaves', pos: new Vec3(3, 8, 9) },
                { block: 'spruce_leaves', pos: new Vec3(4, 8, 9) },
                { block: 'spruce_wood', pos: new Vec3(5, 8, 9) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 8, 9) },
                { block: 'spruce_leaves', pos: new Vec3(7, 8, 9) },
                { block: 'spruce_leaves', pos: new Vec3(5, 8, 10) },
                { block: 'spruce_leaves', pos: new Vec3(6, 8, 10) },
                { block: 'light_blue_glazed_terracotta', pos: new Vec3(6, 9, 2) },
                { block: 'spruce_leaves', pos: new Vec3(7, 9, 3) },
                { block: 'lantern', pos: new Vec3(2, 9, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 9, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 9, 4) },
                { block: 'spruce_wood', pos: new Vec3(7, 9, 4) },
                { block: 'spruce_leaves', pos: new Vec3(8, 9, 4) },
                { block: 'spruce_leaves', pos: new Vec3(2, 9, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 9, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 9, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 9, 5) },
                { block: 'spruce_wood', pos: new Vec3(6, 9, 5) },
                { block: 'spruce_wood', pos: new Vec3(7, 9, 5) },
                { block: 'spruce_wood', pos: new Vec3(8, 9, 5) },
                { block: 'spruce_leaves', pos: new Vec3(9, 9, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 9, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 9, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 9, 6) },
                { block: 'spruce_wood', pos: new Vec3(7, 9, 6) },
                { block: 'dark_oak_fence', pos: new Vec3(8, 9, 6) },
                { block: 'spruce_leaves', pos: new Vec3(9, 9, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 9, 7) },
                { block: 'spruce_leaves', pos: new Vec3(7, 9, 7) },
                { block: 'spruce_leaves', pos: new Vec3(8, 9, 7) },
                { block: 'spruce_leaves', pos: new Vec3(3, 9, 8) },
                { block: 'spruce_leaves', pos: new Vec3(4, 9, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 9, 8) },
                { block: 'spruce_leaves', pos: new Vec3(6, 9, 8) },
                { block: 'spruce_leaves', pos: new Vec3(7, 9, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 9, 9) },
                { block: 'spruce_leaves', pos: new Vec3(6, 9, 9) },
                { block: 'spruce_leaves', pos: new Vec3(5, 10, 2) },
                { block: 'lantern', pos: new Vec3(6, 10, 2) },
                { block: 'spruce_leaves', pos: new Vec3(2, 10, 3) },
                { block: 'spruce_leaves', pos: new Vec3(3, 10, 3) },
                { block: 'spruce_leaves', pos: new Vec3(4, 10, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 10, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 10, 3) },
                { block: 'spruce_leaves', pos: new Vec3(1, 10, 4) },
                { block: 'dark_oak_fence', pos: new Vec3(2, 10, 4) },
                { block: 'spruce_wood', pos: new Vec3(3, 10, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 10, 4) },
                { block: 'spruce_leaves', pos: new Vec3(5, 10, 4) },
                { block: 'spruce_leaves', pos: new Vec3(7, 10, 4) },
                { block: 'spruce_leaves', pos: new Vec3(1, 10, 5) },
                { block: 'spruce_wood', pos: new Vec3(2, 10, 5) },
                { block: 'spruce_wood', pos: new Vec3(3, 10, 5) },
                { block: 'spruce_wood', pos: new Vec3(4, 10, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 10, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 10, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 10, 5) },
                { block: 'spruce_leaves', pos: new Vec3(8, 10, 5) },
                { block: 'spruce_leaves', pos: new Vec3(2, 10, 6) },
                { block: 'spruce_wood', pos: new Vec3(3, 10, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 10, 6) },
                { block: 'spruce_leaves', pos: new Vec3(7, 10, 6) },
                { block: 'spruce_leaves', pos: new Vec3(8, 10, 6) },
                { block: 'spruce_leaves', pos: new Vec3(3, 10, 7) },
                { block: 'lime_glazed_terracotta', pos: new Vec3(6, 10, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 11, 1) },
                { block: 'spruce_leaves', pos: new Vec3(6, 11, 1) },
                { block: 'spruce_leaves', pos: new Vec3(4, 11, 2) },
                { block: 'spruce_wood', pos: new Vec3(5, 11, 2) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 11, 2) },
                { block: 'spruce_leaves', pos: new Vec3(7, 11, 2) },
                { block: 'spruce_leaves', pos: new Vec3(3, 11, 3) },
                { block: 'spruce_wood', pos: new Vec3(4, 11, 3) },
                { block: 'spruce_wood', pos: new Vec3(5, 11, 3) },
                { block: 'spruce_wood', pos: new Vec3(6, 11, 3) },
                { block: 'spruce_leaves', pos: new Vec3(7, 11, 3) },
                { block: 'spruce_leaves', pos: new Vec3(2, 11, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 11, 4) },
                { block: 'spruce_wood', pos: new Vec3(5, 11, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 11, 4) },
                { block: 'yellow_glazed_terracotta', pos: new Vec3(7, 11, 4) },
                { block: 'spruce_leaves', pos: new Vec3(2, 11, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 11, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 11, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 11, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 11, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 11, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 11, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 11, 7) },
                { block: 'spruce_leaves', pos: new Vec3(6, 11, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 11, 8) },
                { block: 'lantern', pos: new Vec3(6, 11, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 12, 2) },
                { block: 'spruce_leaves', pos: new Vec3(6, 12, 2) },
                { block: 'spruce_leaves', pos: new Vec3(4, 12, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 12, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 12, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 12, 4) },
                { block: 'lantern', pos: new Vec3(7, 12, 4) },
                { block: 'spruce_log', pos: new Vec3(5, 12, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 12, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 12, 5) },
                { block: 'light_blue_glazed_terracotta', pos: new Vec3(3, 12, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 12, 6) },
                { block: 'spruce_wood', pos: new Vec3(5, 12, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 12, 6) },
                { block: 'spruce_leaves', pos: new Vec3(3, 12, 7) },
                { block: 'spruce_wood', pos: new Vec3(4, 12, 7) },
                { block: 'spruce_wood', pos: new Vec3(5, 12, 7) },
                { block: 'spruce_wood', pos: new Vec3(6, 12, 7) },
                { block: 'spruce_leaves', pos: new Vec3(7, 12, 7) },
                { block: 'spruce_leaves', pos: new Vec3(4, 12, 8) },
                { block: 'spruce_wood', pos: new Vec3(5, 12, 8) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 12, 8) },
                { block: 'spruce_leaves', pos: new Vec3(7, 12, 8) },
                { block: 'spruce_leaves', pos: new Vec3(5, 12, 9) },
                { block: 'spruce_leaves', pos: new Vec3(6, 12, 9) },
                { block: 'red_glazed_terracotta', pos: new Vec3(4, 13, 3) },
                { block: 'spruce_leaves', pos: new Vec3(7, 13, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 13, 4) },
                { block: 'dark_oak_fence', pos: new Vec3(7, 13, 4) },
                { block: 'spruce_leaves', pos: new Vec3(8, 13, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 13, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 13, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 13, 5) },
                { block: 'spruce_wood', pos: new Vec3(6, 13, 5) },
                { block: 'spruce_wood', pos: new Vec3(7, 13, 5) },
                { block: 'spruce_leaves', pos: new Vec3(8, 13, 5) },
                { block: 'lantern', pos: new Vec3(3, 13, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 13, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 13, 6) },
                { block: 'spruce_leaves', pos: new Vec3(7, 13, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 13, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 13, 7) },
                { block: 'spruce_leaves', pos: new Vec3(6, 13, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 13, 8) },
                { block: 'spruce_leaves', pos: new Vec3(6, 13, 8) },
                { block: 'lantern', pos: new Vec3(4, 14, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 14, 3) },
                { block: 'spruce_leaves', pos: new Vec3(3, 14, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 14, 4) },
                { block: 'spruce_leaves', pos: new Vec3(5, 14, 4) },
                { block: 'spruce_leaves', pos: new Vec3(7, 14, 4) },
                { block: 'spruce_leaves', pos: new Vec3(2, 14, 5) },
                { block: 'spruce_wood', pos: new Vec3(3, 14, 5) },
                { block: 'spruce_wood', pos: new Vec3(4, 14, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 14, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 14, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 14, 5) },
                { block: 'spruce_leaves', pos: new Vec3(2, 14, 6) },
                { block: 'dark_oak_fence', pos: new Vec3(3, 14, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 14, 6) },
                { block: 'spruce_leaves', pos: new Vec3(3, 14, 7) },
                { block: 'red_glazed_terracotta', pos: new Vec3(6, 14, 7) },
                { block: 'spruce_leaves', pos: new Vec3(4, 15, 2) },
                { block: 'spruce_leaves', pos: new Vec3(5, 15, 2) },
                { block: 'spruce_leaves', pos: new Vec3(3, 15, 3) },
                { block: 'dark_oak_fence', pos: new Vec3(4, 15, 3) },
                { block: 'spruce_wood', pos: new Vec3(5, 15, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 15, 3) },
                { block: 'spruce_leaves', pos: new Vec3(4, 15, 4) },
                { block: 'spruce_wood', pos: new Vec3(5, 15, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 15, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 15, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 15, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 15, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 15, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 15, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 15, 7) },
                { block: 'lantern', pos: new Vec3(6, 15, 7) },
                { block: 'spruce_leaves', pos: new Vec3(4, 16, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 16, 3) },
                { block: 'spruce_leaves', pos: new Vec3(5, 16, 4) },
                { block: 'yellow_glazed_terracotta', pos: new Vec3(3, 16, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 16, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 16, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 16, 6) },
                { block: 'spruce_wood', pos: new Vec3(5, 16, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 16, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 16, 7) },
                { block: 'spruce_wood', pos: new Vec3(5, 16, 7) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 16, 7) },
                { block: 'spruce_leaves', pos: new Vec3(7, 16, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 16, 8) },
                { block: 'spruce_leaves', pos: new Vec3(6, 16, 8) },
                { block: 'lime_glazed_terracotta', pos: new Vec3(6, 17, 4) },
                { block: 'lantern', pos: new Vec3(3, 17, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 17, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 17, 5) },
                { block: 'spruce_wood', pos: new Vec3(6, 17, 5) },
                { block: 'spruce_leaves', pos: new Vec3(7, 17, 5) },
                { block: 'spruce_leaves', pos: new Vec3(5, 17, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 17, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 17, 7) },
                { block: 'spruce_leaves', pos: new Vec3(6, 17, 7) },
                { block: 'spruce_leaves', pos: new Vec3(3, 18, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 18, 4) },
                { block: 'spruce_leaves', pos: new Vec3(5, 18, 4) },
                { block: 'lantern', pos: new Vec3(6, 18, 4) },
                { block: 'spruce_leaves', pos: new Vec3(2, 18, 5) },
                { block: 'dark_oak_fence', pos: new Vec3(3, 18, 5) },
                { block: 'spruce_wood', pos: new Vec3(4, 18, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 18, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 18, 5) },
                { block: 'spruce_leaves', pos: new Vec3(3, 18, 6) },
                { block: 'spruce_leaves', pos: new Vec3(4, 18, 6) },
                { block: 'purple_glazed_terracotta', pos: new Vec3(6, 18, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 19, 3) },
                { block: 'spruce_leaves', pos: new Vec3(6, 19, 3) },
                { block: 'spruce_leaves', pos: new Vec3(4, 19, 4) },
                { block: 'spruce_wood', pos: new Vec3(5, 19, 4) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 19, 4) },
                { block: 'spruce_leaves', pos: new Vec3(7, 19, 4) },
                { block: 'spruce_leaves', pos: new Vec3(3, 19, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 19, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 19, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 19, 5) },
                { block: 'spruce_leaves', pos: new Vec3(5, 19, 6) },
                { block: 'lantern', pos: new Vec3(6, 19, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 20, 4) },
                { block: 'spruce_leaves', pos: new Vec3(6, 20, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 20, 5) },
                { block: 'spruce_log', pos: new Vec3(5, 20, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 20, 5) },
                { block: 'spruce_leaves', pos: new Vec3(4, 20, 6) },
                { block: 'spruce_wood', pos: new Vec3(5, 20, 6) },
                { block: 'dark_oak_fence', pos: new Vec3(6, 20, 6) },
                { block: 'spruce_leaves', pos: new Vec3(7, 20, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 20, 7) },
                { block: 'spruce_leaves', pos: new Vec3(6, 20, 7) },
                { block: 'spruce_leaves', pos: new Vec3(5, 21, 4) },
                { block: 'spruce_leaves', pos: new Vec3(4, 21, 5) },
                { block: 'spruce_wood', pos: new Vec3(5, 21, 5) },
                { block: 'spruce_leaves', pos: new Vec3(6, 21, 5) },
                { block: 'spruce_leaves', pos: new Vec3(5, 21, 6) },
                { block: 'spruce_leaves', pos: new Vec3(6, 21, 6) },
                { block: 'spruce_leaves', pos: new Vec3(5, 22, 5) },
                { block: 'glowstone', pos: new Vec3(5, 23, 5) }
                ];
            }

            let successCount = 0;
            let failCount = 0;
            const horizontalOffset = 3; // Fixed horizontal distance from target block (X axis)
            let directionIndex = 0; // 0=East, 1=South, 2=West, 3=North (rotating around tree)

            // Execute blueprint sequentially using teleportation protocol
            for (let i = 0; i < blueprint.length; i++) {
                const entry = blueprint[i];
                const relativePos = entry.pos;
                const absoluteX = baseX + Math.floor(relativePos.x);
                const absoluteY = baseY + Math.floor(relativePos.y);
                const absoluteZ = baseZ + Math.floor(relativePos.z);
                const targetPos = new Vec3(absoluteX, absoluteY, absoluteZ);
                
                try {
                    console.log(`[SKILLS] Placing block ${i + 1}/${blueprint.length}: ${entry.block} at (${absoluteX}, ${absoluteY}, ${absoluteZ})`);
                    
                    // Voxel-Aligned Teleport Protocol:
                    // CRITICAL: Agent must appear on the SIDE of AIR (not behind, above, or below the target block)
                    // This ensures agent can face the target block directly for placement in Java Edition
                    // Agent must be positioned on the side of air, facing the block directly
                    
                    // Find the best air position adjacent to target block
                    // ONLY use side directions (East/West/South/North) - NEVER above or below
                    // This prevents angle problems where agent can't place blocks properly
                    const sideDirections = [
                        new Vec3(1, 0, 0),   // East (X+)
                        new Vec3(-1, 0, 0),  // West (X-)
                        new Vec3(0, 0, 1),   // South (Z+)
                        new Vec3(0, 0, -1)   // North (Z-)
                    ];
                    
                    let teleportPos = null;
                    let bestDirection = null;
                    
                    // Try to find an air block on the SIDE of target (only horizontal directions)
                    for (let dirIdx = 0; dirIdx < sideDirections.length; dirIdx++) {
                        const dir = sideDirections[dirIdx];
                        const candidatePos = targetPos.plus(dir);
                        const candidateBlock = bot.blockAt(candidatePos);
                        
                        // Check if this position is air (or can be used)
                        if (!candidateBlock || candidateBlock.name === 'air' || candidateBlock.type === 0) {
                            // This is a valid air position on the side
                            teleportPos = candidatePos;
                            bestDirection = dir;
                            console.log(`[SKILLS] Found air position at (${teleportPos.x}, ${teleportPos.y}, ${teleportPos.z}) on side (${dirIdx === 0 ? 'East' : dirIdx === 1 ? 'West' : dirIdx === 2 ? 'South' : 'North'})`);
                            break;
                        }
                    }
                    
                    // If no air found on sides, use default side position (will be air after teleport)
                    if (!teleportPos) {
                        const defaultDir = sideDirections[directionIndex % 4]; // Use cardinal direction
                        teleportPos = targetPos.plus(defaultDir);
                        bestDirection = defaultDir;
                        console.log(`[SKILLS] Using default side position at (${teleportPos.x}, ${teleportPos.y}, ${teleportPos.z})`);
                    }
                    
                    // CRITICAL: Always use Y+1 for side positions to ensure proper placement angle
                    // Agent must be at the same Y level or slightly above the target block
                        teleportPos.y = absoluteY + 1;
                    
                    // 2. Execute teleportation (silent mode - no console output)
                    bot.chat(`/tp ${bot.username} ${Math.floor(teleportPos.x)} ${Math.floor(teleportPos.y)} ${Math.floor(teleportPos.z)}`);
                    
                    // Update expected position for position maintenance loop
                    lastTeleportPos = new Vec3(teleportPos.x, teleportPos.y, teleportPos.z);
                    expectedHeight = teleportPos.y;
                    
                    await new Promise(resolve => setTimeout(resolve, 200)); // Wait for teleport to complete
                    
                    // CRITICAL: Immediately face the target block directly after teleporting
                    // This ensures the agent is looking at the block for proper placement in Java Edition
                    const targetLookPos = targetPos.plus(new Vec3(0.5, 0.5, 0.5));
                    bot.lookAt(targetLookPos, true);
                    await new Promise(resolve => setTimeout(resolve, 150)); // Wait for look to complete
                    
                    // 3. CRITICAL: Immediately check and correct position after teleport (silent mode)
                    // Don't rely on flight commands - use direct position correction
                    await new Promise(resolve => setTimeout(resolve, 50));
                    const currentY = bot.entity.position.y;
                    
                    // If position is wrong, immediately correct (anti-gravity, silent)
                    if (Math.abs(currentY - teleportPos.y) > 0.3) {
                        bot.chat(`/tp ${bot.username} ${Math.floor(teleportPos.x)} ${Math.floor(teleportPos.y)} ${Math.floor(teleportPos.z)}`);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    
                    // Try flight commands silently (but don't rely on them - position correction is primary)
                    bot.chat('/fly');
                    bot.chat('/ability @s mayfly true');
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                    // 4. Force stationary state
                    try {
                        // Reset velocity to zero (eliminate inertia)
                        if (bot.entity && bot.entity.velocity) {
                            bot.entity.velocity.set(0, 0, 0);
                        }
                        // Force entity to not be on ground
                        if (bot.entity) {
                            bot.entity.onGround = false;
                        }
                        // Ensure jump is disabled
                        bot.setControlState('jump', false);
                    } catch (error) {
                        // Ignore errors
                    }
                    
                    // 5. Final position check before placing block (silent mode)
                    await new Promise(resolve => setTimeout(resolve, 50));
                    const finalY = bot.entity.position.y;
                    if (finalY < teleportPos.y - 0.3) {
                        bot.chat(`/tp ${bot.username} ${Math.floor(teleportPos.x)} ${Math.floor(teleportPos.y)} ${Math.floor(teleportPos.z)}`);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    
                    // 4. Replace block using /setblock command (no adjacency requirements)
                    const targetBlock = bot.blockAt(targetPos);
                    
                    // Check if block is already correct
                    if (targetBlock && targetBlock.name === entry.block) {
                        console.log(`[SKILLS] Block ${entry.block} already exists at (${absoluteX}, ${absoluteY}, ${absoluteZ}), skipping`);
                        successCount++;
                            continue;
                        }
                        
                    // Convert block name to Minecraft format (e.g., 'oak_log' -> 'minecraft:oak_log')
                    const minecraftBlockName = entry.block.startsWith('minecraft:') ? entry.block : `minecraft:${entry.block}`;
                    
                    // Use /setblock command to directly replace the block (including air)
                    // Format: /setblock <x> <y> <z> <block> replace
                    // Only log if not in silent mode
                    if (!BEHAVIOR_CONFIG.silentMode) {
                        console.log(`[SKILLS] Replacing block at (${absoluteX}, ${absoluteY}, ${absoluteZ}) with ${minecraftBlockName} using /setblock command`);
                    }
                    
                    // Execute /setblock command (server will show feedback unless sendCommandFeedback is false)
                    bot.chat(`/setblock ${absoluteX} ${absoluteY} ${absoluteZ} ${minecraftBlockName} replace`);
                                    
                                    // Wait for block update
                                    await new Promise(resolve => setTimeout(resolve, 300));
                                    
                                    // Verify placement
                                    const placedBlock = bot.blockAt(targetPos);
                                    if (placedBlock && placedBlock.name === entry.block) {
                                        successCount++;
                        console.log(`[SKILLS] ✓ Successfully replaced block with ${entry.block} at (${absoluteX}, ${absoluteY}, ${absoluteZ})`);
                                    } else {
                        // Try one more time after a delay
                                            await new Promise(resolve => setTimeout(resolve, 200));
                        const retryCheck = bot.blockAt(targetPos);
                        if (retryCheck && retryCheck.name === entry.block) {
                            successCount++;
                            console.log(`[SKILLS] ✓ Successfully replaced block with ${entry.block} at (${absoluteX}, ${absoluteY}, ${absoluteZ}) (retry check)`);
                                    } else {
                            failCount++;
                            console.warn(`[SKILLS] ✗ Replacement verification failed - expected ${entry.block}, got ${placedBlock?.name || 'null'}`);
                        }
                    }
                    
                    // 7. Rotate to next direction for next block (to avoid occlusion)
                    if (i % 4 === 3) {
                        directionIndex = (directionIndex + 1) % 4; // Change direction every 4 blocks
                    }
                    
                    // Small delay between placements
                    await new Promise(resolve => setTimeout(resolve, 150));
                } catch (error) {
                    failCount++;
                    console.error(`[SKILLS] Error placing block at (${absoluteX}, ${absoluteY}, ${absoluteZ}): ${error.message}`);
                }
            }

            // Stop flight maintenance loop
            if (flightMaintenanceInterval) {
                clearInterval(flightMaintenanceInterval);
                flightMaintenanceInterval = null;
                console.log('[SKILLS] Flight maintenance stopped');
            }
            
            // Ensure jump control is re-enabled
            bot.setControlState('jump', false);
            
            // Restore behavior state
            behaviorState.isMoving = false;
            
            // Clear task execution flag (re-enables jump control)
            behaviorState.isExecutingTask = false;
            behaviorState.workCenter = null;
            
            // Restore behavior system
            BEHAVIOR_CONFIG.enabled = wasBehaviorEnabled;
            if (wasBehaviorEnabled) {
                startNaturalBehavior();
            }
            
            // Restore player following state
            behaviorState.isFollowing = wasFollowing;
            behaviorState.followingPlayer = wasFollowingPlayer;

            const result = `Christmas tree built: ${successCount} blocks placed, ${failCount} failed`;
            console.log(`[SKILLS] ${result}`);
            
            if (failCount > 0) {
                bot.chat(`Tree building completed with ${failCount} errors. Some blocks may need manual placement.`);
                console.warn(`[SKILLS] Some blocks failed to place. Bot may need items in inventory or creative mode.`);
            } else {
                bot.chat('Christmas tree built successfully!');
            }
            
            return result;
        } catch (error) {
            console.error(`[SKILLS] Error in buildTree: ${error.message}`);
            bot.chat(`Error building tree: ${error.message}`);
            
            // Stop flight maintenance loop on error
            if (flightMaintenanceInterval) {
                clearInterval(flightMaintenanceInterval);
                flightMaintenanceInterval = null;
            }
            
            // Ensure jump control is re-enabled
            bot.setControlState('jump', false);
            
            // Restore behavior system on error
            BEHAVIOR_CONFIG.enabled = wasBehaviorEnabled;
            if (wasBehaviorEnabled) {
                startNaturalBehavior();
            }
            
            // Reset all state
            behaviorState.isMoving = false;
            behaviorState.isExecutingTask = false;
            behaviorState.workCenter = null;
            behaviorState.isFollowing = false;
            behaviorState.followingPlayer = null;
            throw error;
        }
    },

    /**
     * Celebrates by summoning fireworks
     * @returns {Promise<string>} Success message
     */
    async celebrate() {
        try {
            console.log(`[SKILLS] Celebrating with fireworks`);
            const botPos = bot.entity.position;
            const fireworkPos = new Vec3(botPos.x, botPos.y + 5, botPos.z);
            
            bot.chat(`/summon firework_rocket ${fireworkPos.x} ${fireworkPos.y} ${fireworkPos.z}`);
            
            console.log(`[SKILLS] Fireworks summoned`);
            return 'Fireworks summoned successfully';
        } catch (error) {
            console.error(`[SKILLS] Error in celebrate: ${error.message}`);
            throw error;
        }
    },

    /**
     * Performs a physical nodding gesture (more natural)
     * @returns {Promise<string>} Success message
     */
    async nod() {
        try {
            console.log(`[SKILLS] Performing nod gesture`);
            
            // Temporarily disable natural behavior
            const wasMoving = behaviorState.isMoving;
            behaviorState.isMoving = true;
            
            // Look up smoothly
            for (let i = 0; i <= 5; i++) {
                const pitch = -0.5 * (i / 5);
                bot.look(0, pitch, true);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Look down smoothly
            for (let i = 0; i <= 5; i++) {
                const pitch = -0.5 + (0.5 * (i / 5));
                bot.look(0, pitch, true);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Return to neutral smoothly
            for (let i = 0; i <= 5; i++) {
                const pitch = 0.5 * (1 - i / 5);
                bot.look(0, pitch, true);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            // Restore behavior state
            behaviorState.isMoving = wasMoving;
            
            console.log(`[SKILLS] Nod gesture completed`);
            return 'Nod gesture completed';
        } catch (error) {
            console.error(`[SKILLS] Error in nod: ${error.message}`);
            throw error;
        }
    }
};

// Bot event handlers
/**
 * Gets username from a player entity
 * @param {Object} entity - Player entity
 * @returns {string|null} Username or null if not found
 */
function getUsernameFromEntity(entity) {
    for (const username in bot.players) {
        if (bot.players[username].entity === entity) {
            return username;
        }
    }
    return null;
}

/**
 * Finds nearest player within detection range
 * @returns {Object|null} Nearest player entity or null
 */
function findNearestPlayer() {
    if (!BEHAVIOR_CONFIG.followPlayer.enabled) {
        return null;
    }

    const botPos = bot.entity.position;
    const detectionRange = BEHAVIOR_CONFIG.followPlayer.detectionRange;
    let nearestPlayer = null;
    let nearestDistance = detectionRange;

    // Use bot.players to get all players (more reliable than checking entities)
    const playerCount = Object.keys(bot.players).length;
    if (playerCount === 0) {
        return null;
    }

    for (const username in bot.players) {
        const player = bot.players[username];
        
        // Skip the bot itself
        if (username === bot.username) {
            continue;
        }
        
        // Get the entity for this player
        if (player && player.entity && player.entity.position) {
            const distance = botPos.distanceTo(player.entity.position);
            
            if (distance < nearestDistance && distance > 0) {
                nearestDistance = distance;
                nearestPlayer = player.entity;
            }
        } else if (player && !player.entity) {
            // Player exists but entity not loaded yet
            console.log(`[BEHAVIOR] Player ${username} detected but entity not loaded yet`);
        }
    }

    if (nearestPlayer) {
        const username = getUsernameFromEntity(nearestPlayer);
        console.log(`[BEHAVIOR] Found nearest player: ${username} at ${nearestDistance.toFixed(1)} blocks`);
    }

    return nearestPlayer;
}

/**
 * Follows a player, maintaining a safe distance
 * @param {Object} playerEntity - Player entity to follow
 * @returns {Promise<boolean>} Success status
 */
async function followPlayer(playerEntity) {
    if (!playerEntity || !playerEntity.position) {
        return false;
    }

    // Don't follow if executing a task
    if (behaviorState.isExecutingTask) {
        console.log('[BEHAVIOR] Task execution in progress, skipping follow');
        return false;
    }

    try {
        // Find the username for this entity
        const playerUsername = getUsernameFromEntity(playerEntity);
        
        if (!playerUsername) {
            console.warn('[BEHAVIOR] Could not find username for player entity');
            return false;
        }

        const botPos = bot.entity.position;
        const playerPos = playerEntity.position;
        const distance = botPos.distanceTo(playerPos);
        const followDistance = BEHAVIOR_CONFIG.followPlayer.followDistance;

        // If too close, don't move (maintain distance)
        if (distance <= followDistance + 1) {
            // Look at player
            bot.lookAt(playerPos.plus(new Vec3(0, 1.6, 0))); // Look at player's head
            behaviorState.isFollowing = true;
            behaviorState.followingPlayer = playerUsername;
            return true;
        }

        // Calculate position to move to: move towards player but stop at followDistance
        // Direction from player to bot (to maintain relative position)
        const directionFromPlayer = botPos.minus(playerPos);
        const directionLength = Math.sqrt(
            directionFromPlayer.x * directionFromPlayer.x +
            directionFromPlayer.y * directionFromPlayer.y +
            directionFromPlayer.z * directionFromPlayer.z
        );
        
        // Normalize the direction vector manually
        let normalizedDirection;
        if (directionLength > 0.001) { // Avoid division by zero
            normalizedDirection = new Vec3(
                directionFromPlayer.x / directionLength,
                directionFromPlayer.y / directionLength,
                directionFromPlayer.z / directionLength
            );
        } else {
            // If bot and player are at same position, use a default direction
            normalizedDirection = new Vec3(1, 0, 0);
        }
        
        // Target position: playerPos plus normalized direction scaled by followDistance
        // This maintains relative position while getting closer
        const targetPos = playerPos.plus(normalizedDirection.scaled(followDistance));
        targetPos.y = playerPos.y; // Same Y level as player

        console.log(`[BEHAVIOR] Following player ${playerUsername} (distance: ${distance.toFixed(1)} blocks, target: ${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
        
        behaviorState.isMoving = true;
        behaviorState.isFollowing = true;
        behaviorState.followingPlayer = playerUsername;
        behaviorState.currentGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.5);
        
        // Look at player while moving
        bot.lookAt(playerPos.plus(new Vec3(0, 1.6, 0)));
        
        await bot.pathfinder.goto(behaviorState.currentGoal);
        
        behaviorState.isMoving = false;
        behaviorState.currentGoal = null;
        behaviorState.lastFollowCheck = Date.now();
        
        return true;
    } catch (error) {
        console.error(`[BEHAVIOR] Error following player: ${error.message}`);
        behaviorState.isMoving = false;
        behaviorState.isFollowing = false;
        behaviorState.followingPlayer = null;
        behaviorState.currentGoal = null;
        return false;
    }
}

/**
 * Natural random walking behavior (like villagers/cows)
 * Only executes if not following a player
 */
async function randomWalk() {
    // Don't random walk if following a player
    if (behaviorState.isFollowing) {
        return;
    }

    if (!BEHAVIOR_CONFIG.randomWalk.enabled || behaviorState.isMoving) {
        return;
    }

    try {
        const currentPos = bot.entity.position;
        const distance = BEHAVIOR_CONFIG.randomWalk.minDistance + 
                        Math.random() * (BEHAVIOR_CONFIG.randomWalk.maxDistance - BEHAVIOR_CONFIG.randomWalk.minDistance);
        const angle = Math.random() * Math.PI * 2;
        
        const targetX = currentPos.x + Math.cos(angle) * distance;
        const targetZ = currentPos.z + Math.sin(angle) * distance;
        const targetY = currentPos.y;
        
        const targetPos = new Vec3(targetX, targetY, targetZ);
        
        console.log(`[BEHAVIOR] Random walk to (${Math.floor(targetX)}, ${Math.floor(targetY)}, ${Math.floor(targetZ)})`);
        
        behaviorState.isMoving = true;
        behaviorState.currentGoal = new GoalNear(targetX, targetY, targetZ, 2);
        
        await bot.pathfinder.goto(behaviorState.currentGoal);
        
        behaviorState.isMoving = false;
        behaviorState.currentGoal = null;
        behaviorState.lastWalkTime = Date.now();
    } catch (error) {
        console.error(`[BEHAVIOR] Error in random walk: ${error.message}`);
        behaviorState.isMoving = false;
        behaviorState.currentGoal = null;
    }
}

/**
 * Natural looking around behavior
 */
function lookAround() {
    if (!BEHAVIOR_CONFIG.lookAround.enabled || behaviorState.isLooking) {
        return;
    }

    try {
        behaviorState.isLooking = true;
        
        // Random yaw (horizontal) and pitch (vertical)
        const yaw = (Math.random() - 0.5) * BEHAVIOR_CONFIG.lookAround.maxYaw;
        const pitch = (Math.random() - 0.5) * BEHAVIOR_CONFIG.lookAround.maxPitch;
        
        bot.look(yaw, pitch, true);
        
        setTimeout(() => {
            behaviorState.isLooking = false;
            behaviorState.lastLookTime = Date.now();
        }, 500 + Math.random() * 1000); // Look for 0.5-1.5 seconds
    } catch (error) {
        console.error(`[BEHAVIOR] Error in look around: ${error.message}`);
        behaviorState.isLooking = false;
    }
}

/**
 * Idle actions (jumping, etc.)
 */
function performIdleAction() {
    if (!BEHAVIOR_CONFIG.idleActions.enabled || behaviorState.isMoving) {
        return;
    }

    try {
        // Random jump
        if (Math.random() < BEHAVIOR_CONFIG.idleActions.jumpChance) {
            bot.setControlState('jump', true);
            setTimeout(() => {
                bot.setControlState('jump', false);
            }, 200 + Math.random() * 300);
            console.log('[BEHAVIOR] Random jump');
        }
        
        behaviorState.lastIdleActionTime = Date.now();
    } catch (error) {
        console.error(`[BEHAVIOR] Error in idle action: ${error.message}`);
    }
}

/**
 * Check for nearby players and follow them
 */
async function checkAndFollowPlayers() {
    // Don't follow if disabled, moving, or executing a task
    if (!BEHAVIOR_CONFIG.followPlayer.enabled || behaviorState.isMoving || behaviorState.isExecutingTask) {
        return;
    }

    const nearestPlayerEntity = findNearestPlayer();
    
    if (nearestPlayerEntity) {
        // Find the username for this entity
        const playerUsername = getUsernameFromEntity(nearestPlayerEntity);
        
        if (playerUsername) {
            // Found a player, follow them
            if (!behaviorState.isFollowing || behaviorState.followingPlayer !== playerUsername) {
                console.log(`[BEHAVIOR] Detected player: ${playerUsername}, starting to follow`);
            }
            await followPlayer(nearestPlayerEntity);
        }
    } else {
        // No player nearby, stop following
        if (behaviorState.isFollowing) {
            console.log(`[BEHAVIOR] Player ${behaviorState.followingPlayer} out of range, stopping follow`);
            behaviorState.isFollowing = false;
            behaviorState.followingPlayer = null;
        }
    }
}

/**
 * Stop all natural behavior loops
 * Critical for preventing interference during tasks
 */
function stopNaturalBehavior() {
    console.log('[BEHAVIOR] Stopping all behavior loops');
    behaviorState.behaviorIntervals.forEach(intervalId => {
        clearInterval(intervalId);
    });
    behaviorState.behaviorIntervals = [];
    
    // Stop pathfinder
    try {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(null);
    } catch (error) {
        // Ignore errors
    }
}

/**
 * Start natural behavior loop
 */
function startNaturalBehavior() {
    if (!BEHAVIOR_CONFIG.enabled) {
        return;
    }

    // Clear any existing intervals first
    stopNaturalBehavior();

    console.log('[BEHAVIOR] Natural behavior system enabled');
    
    // Player follow check loop (highest priority)
    if (BEHAVIOR_CONFIG.followPlayer.enabled) {
        const followInterval = setInterval(() => {
            if (Date.now() - behaviorState.lastFollowCheck > BEHAVIOR_CONFIG.followPlayer.followInterval) {
                checkAndFollowPlayers();
            }
        }, BEHAVIOR_CONFIG.followPlayer.followInterval);
        behaviorState.behaviorIntervals.push(followInterval);
        console.log(`[BEHAVIOR] Player following enabled (range: ${BEHAVIOR_CONFIG.followPlayer.detectionRange} blocks)`);
    }
    
    // Random walk loop (only if not following)
    const walkInterval = setInterval(() => {
        if (!behaviorState.isFollowing && 
            !behaviorState.isMoving && 
            Date.now() - behaviorState.lastWalkTime > BEHAVIOR_CONFIG.randomWalk.interval) {
            randomWalk();
        }
    }, BEHAVIOR_CONFIG.randomWalk.interval);
    behaviorState.behaviorIntervals.push(walkInterval);

    // Look around loop
    const lookInterval = setInterval(() => {
        if (!behaviorState.isLooking && 
            Date.now() - behaviorState.lastLookTime > BEHAVIOR_CONFIG.lookAround.interval) {
            lookAround();
        }
    }, BEHAVIOR_CONFIG.lookAround.interval);
    behaviorState.behaviorIntervals.push(lookInterval);

    // Idle actions loop
    const idleInterval = setInterval(() => {
        if (!behaviorState.isMoving && 
            !behaviorState.isFollowing &&
            Date.now() - behaviorState.lastIdleActionTime > BEHAVIOR_CONFIG.idleActions.interval) {
            performIdleAction();
        }
    }, BEHAVIOR_CONFIG.idleActions.interval);
    behaviorState.behaviorIntervals.push(idleInterval);
}

// Apply Resistance V effect function (reusable)
// Resistance V reduces damage by 20% per level (5 levels = 100% damage reduction)
async function applyResistanceEffect() {
    try {
        // Apply resistance effect: /effect give <target> <effect> <duration> <amplifier> <hideParticles>
        // Duration: 999999 seconds (essentially permanent)
        // Amplifier: 4 (level 5, since amplifier 0 = level 1)
        // hideParticles: true (hide particle effects)
        bot.chat('/effect give @s resistance 999999 4 true');
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[BOT] Resistance V effect applied - fall damage protection enabled');
        return true;
    } catch (error) {
        console.warn('[BOT] Could not apply resistance effect:', error.message);
        return false;
    }
}

bot.on('spawn', async () => {
    console.log('[BOT] Bot spawned successfully');
    bot.chat('Project Noël initialised and ready!');
    bot.chat('Type !usage or !api to check API usage statistics');
    
    // CRITICAL: Configure pathfinder to NEVER break blocks
    try {
        if (bot.pathfinder) {
            const defaultMove = new Movements(bot);
            defaultMove.canDig = false; // Disable digging in pathfinder
            defaultMove.allowParkour = false; // Disable parkour (might involve breaking)
            bot.pathfinder.setMovements(defaultMove);
            console.log('[BOT] Pathfinder configured - block breaking disabled');
        }
    } catch (error) {
        console.warn('[BOT] Could not configure pathfinder:', error.message);
    }
    
    // Enable creative mode (with block breaking protection)
    // Creative mode allows flying and building, but block breaking is still disabled via code protection
    try {
        bot.chat('/gamemode creative');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Flying is automatically enabled in creative mode
        console.log('[BOT] Creative mode enabled - block breaking still disabled via code protection');
    } catch (error) {
        console.warn('[BOT] Could not enable creative mode:', error.message);
    }
    
    // Disable command feedback to silence setblock/tp messages in chat
    // Only set if configured to do so (you can set it manually on server instead)
    if (BEHAVIOR_CONFIG.silentMode && BEHAVIOR_CONFIG.setCommandFeedbackRule) {
        try {
            bot.chat('/gamerule sendCommandFeedback false');
            await new Promise(resolve => setTimeout(resolve, 300));
            console.log('[BOT] Command feedback disabled - setblock/tp messages will be silent');
        } catch (error) {
            console.warn('[BOT] Could not disable command feedback (may require OP):', error.message);
        }
    } else if (BEHAVIOR_CONFIG.silentMode) {
        console.log('[BOT] Silent mode enabled - assuming sendCommandFeedback is already set to false on server');
    }
    
    // Apply Resistance V effect to prevent fall damage
    // Resistance V reduces damage by 20% per level (5 levels = 100% damage reduction)
    await applyResistanceEffect();
    
    // Set up periodic re-application of resistance effect (every 5 minutes)
    // This ensures the effect never expires
    setInterval(() => {
        applyResistanceEffect().catch(err => {
            console.warn('[BOT] Could not refresh resistance effect:', err.message);
        });
    }, 5 * 60 * 1000); // Every 5 minutes
    
    // Attempt to apply custom skin if available
    await applyCustomSkin();
    
    // Log API usage on spawn
    console.log('[API] Usage tracking enabled');
    console.log('[API] Type !usage or !api in-game to check usage statistics');
    
    // Start natural behavior system
    startNaturalBehavior();
});

/**
 * Attempts to apply custom skin from skins directory
 * Supports multiple methods: server plugins, online services, or premium accounts
 */
async function applyCustomSkin() {
    try {
        const skinsDir = path.join(__dirname, 'skins');
        if (!fs.existsSync(skinsDir)) {
            console.log('[SKIN] Skins directory not found, skipping skin application');
            return;
        }

        // Look for PNG skin files in skins directory
        const files = fs.readdirSync(skinsDir);
        const skinFiles = files.filter(file => file.toLowerCase().endsWith('.png'));
        
        if (skinFiles.length === 0) {
            console.log('[SKIN] No skin files found in skins directory');
            console.log('[SKIN] Place your skin PNG file in the skins/ folder to apply it');
            return;
        }

        const skinFile = skinFiles[0];
        const skinPath = path.join(skinsDir, skinFile);
        console.log(`[SKIN] Found skin file: ${skinFile}`);
        
        // Wait a bit for bot to fully connect
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Method 1: Try common skin plugin commands (if server has plugins)
        const skinCommands = [
            `/skin set ${bot.username}`,
            `/skinrestorer set ${bot.username}`,
            `/skin upload ${bot.username}`,
            `/cskin set ${bot.username}`
        ];
        
        console.log(`[SKIN] Attempting to apply skin via server commands...`);
        for (const cmd of skinCommands) {
            try {
                bot.chat(cmd);
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log(`[SKIN] Sent command: ${cmd}`);
            } catch (error) {
                // Continue to next command
            }
        }
        
        // Method 2: Provide instructions for manual setup
        console.log(`[SKIN] ==========================================`);
        console.log(`[SKIN] Skin Application Instructions:`);
        console.log(`[SKIN] ==========================================`);
        console.log(`[SKIN] File location: ${skinPath}`);
        console.log(`[SKIN] Bot username: ${bot.username}`);
        console.log(`[SKIN] `);
        console.log(`[SKIN] Option 1 - Server Plugin (if installed):`);
        console.log(`[SKIN]   In-game: /skin set ${bot.username}`);
        console.log(`[SKIN]   Or: /skinrestorer set ${bot.username}`);
        console.log(`[SKIN] `);
        console.log(`[SKIN] Option 2 - Online Skin Service:`);
        console.log(`[SKIN]   1. Upload ${skinFile} to https://minecraftskinstealer.com/`);
        console.log(`[SKIN]   2. Copy the skin URL`);
        console.log(`[SKIN]   3. Use: /skin url <URL>`);
        console.log(`[SKIN] `);
        console.log(`[SKIN] Option 3 - Use Premium Account:`);
        console.log(`[SKIN]   Set MINECRAFT_USERNAME and MINECRAFT_PASSWORD in .env`);
        console.log(`[SKIN] ==========================================`);
        
    } catch (error) {
        console.error(`[SKIN] Error applying custom skin: ${error.message}`);
    }
}

bot.on('error', (err) => {
    console.error(`[BOT] Error: ${err.message}`);
});

bot.on('kicked', (reason) => {
    console.error(`[BOT] Kicked from server: ${reason}`);
});

// Re-apply resistance effect on death/respawn
bot.on('death', async () => {
    console.log('[BOT] Bot died - will re-apply resistance effect on respawn');
});

bot.on('respawn', async () => {
    console.log('[BOT] Bot respawned - re-applying resistance effect');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for respawn to complete
    await applyResistanceEffect();
});

// CRITICAL: Completely disable block breaking functionality
// Even though bot is in creative mode, block breaking is permanently disabled via code protection
// This ensures the agent cannot break blocks even in creative mode
// Override bot.dig to prevent any block breaking attempts
const originalDig = bot.dig;
bot.dig = function(block) {
    console.warn(`[BLOCK PROTECTION] Block breaking attempt blocked at (${block.position.x}, ${block.position.y}, ${block.position.z})`);
    console.warn(`[BLOCK PROTECTION] Block breaking is permanently disabled (even in creative mode) - returning rejected promise`);
    return Promise.reject(new Error('Block breaking is permanently disabled. The agent cannot break any blocks, even in creative mode.'));
};

// Intercept blockBreak events to prevent any breaking
// This works even in creative mode - any breaking attempt will be blocked
bot.on('blockBreakProgressObserved', (block, destroyStage) => {
    console.warn(`[BLOCK PROTECTION] Block break progress detected at (${block.position.x}, ${block.position.y}, ${block.position.z}) - BLOCKED`);
    // Cancel any breaking by stopping the dig
    try {
        bot.stopDigging();
    } catch (e) {
        // Ignore errors
    }
});

bot.on('blockBreakProgressEnded', (block) => {
    console.warn(`[BLOCK PROTECTION] Block break progress ended at (${block.position.x}, ${block.position.y}, ${block.position.z})`);
});

// OpenAI Tool Calling Logic (Cognitive Layer)
bot.on('chat', async (username, message) => {
    // Filter own messages
    if (username === bot.username) {
        return;
    }

    // Check for API usage command
    if (message.toLowerCase() === '!usage' || message.toLowerCase() === '!api' || message.toLowerCase() === '!cost' || message.toLowerCase() === '!money') {
        const usage = getAPIUsage();
        const runtimeHours = (usage.runtime / 60).toFixed(2);
        bot.chat(`📊 API Usage Statistics:`);
        bot.chat(`💰 Total Cost: $${usage.cost.usd.toFixed(4)} USD`);
        bot.chat(`📞 Requests: ${usage.requests}`);
        bot.chat(`🔤 Tokens: ${usage.tokens.total.toLocaleString()} (Prompt: ${usage.tokens.prompt.toLocaleString()}, Completion: ${usage.tokens.completion.toLocaleString()})`);
        bot.chat(`⏱️  Runtime: ${runtimeHours} hours`);
        bot.chat(`📈 Avg per request: $${usage.avgCostPerRequest.toFixed(6)} USD`);
        logAPIUsage();
        return;
    }

    try {
        console.log(`[CHAT] ${username}: ${message}`);
        
        // Add user message to conversation history
        conversationHistory.push({
            role: 'user',
            content: message
        });

        // Call OpenAI API with rate limit handling
        const completion = await callOpenAIWithRetry(() => 
            openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...conversationHistory
                ],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'execute_tasks',
                        description: 'Execute a task in Minecraft',
                        parameters: {
                            type: 'object',
                            properties: {
                                action: {
                                    type: 'string',
                                    enum: ['nod', 'build', 'celebrate'],
                                    description: 'The action to execute'
                                }
                            },
                            required: ['action']
                        }
                    }
                }],
                tool_choice: 'auto'
            })
        );

        // Track API usage
        if (completion.usage) {
            trackAPIUsage(completion.usage);
        }

        const responseMessage = completion.choices[0].message;
        
        // Handle tool calls
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            // Add assistant message with tool_calls to history
            conversationHistory.push({
                role: 'assistant',
                content: responseMessage.content || null,
                tool_calls: responseMessage.tool_calls
            });

            const toolResults = [];
            
            // Execute all tool calls
            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === 'execute_tasks') {
                    const args = JSON.parse(toolCall.function.arguments);
                    const action = args.action;
                    
                    console.log(`[TOOL] Executing action: ${action}`);
                    
                    // Announce intent
                    bot.chat(`Executing: ${action}`);
                    
                    let result;
                    try {
                        switch (action) {
                            case 'nod':
                                result = await SKILLS.nod();
                                break;
                            case 'build':
                                const groundPos = await SKILLS.findGround(bot.entity.position);
                                if (!groundPos) {
                                    throw new Error('Could not find suitable ground position');
                                }
                                result = await SKILLS.buildTree(groundPos);
                                break;
                            case 'celebrate':
                                result = await SKILLS.celebrate();
                                break;
                            default:
                                throw new Error(`Unknown action: ${action}`);
                        }
                        
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: 'execute_tasks',
                            content: JSON.stringify({ success: true, result })
                        });
                    } catch (error) {
                        console.error(`[TOOL] Error executing ${action}: ${error.message}`);
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: 'execute_tasks',
                            content: JSON.stringify({ success: false, error: error.message })
                        });
                    }
                }
            }

            // Add tool results to conversation history (required for next API call)
            conversationHistory.push(...toolResults);

            // Send tool results back to OpenAI for follow-up response
            if (toolResults.length > 0) {
                const followUpCompletion = await callOpenAIWithRetry(() =>
                    openai.chat.completions.create({
                        model: 'gpt-4o',
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            ...conversationHistory
                        ],
                        tools: [{
                            type: 'function',
                            function: {
                                name: 'execute_tasks',
                                description: 'Execute a task in Minecraft',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        action: {
                                            type: 'string',
                                            enum: ['nod', 'build', 'celebrate'],
                                            description: 'The action to execute'
                                        }
                                    },
                                    required: ['action']
                                }
                            }
                        }],
                        tool_choice: 'auto'
                    })
                );

                // Track follow-up API usage
                if (followUpCompletion.usage) {
                    trackAPIUsage(followUpCompletion.usage);
                }

                const followUpMessage = followUpCompletion.choices[0].message;
                if (followUpMessage.content) {
                    bot.chat(followUpMessage.content);
                    // Add follow-up assistant response to history
                    conversationHistory.push({
                        role: 'assistant',
                        content: followUpMessage.content,
                        tool_calls: followUpMessage.tool_calls || undefined
                    });
                } else if (followUpMessage.tool_calls) {
                    // If follow-up also has tool_calls, add it and handle recursively
                    conversationHistory.push({
                        role: 'assistant',
                        content: null,
                        tool_calls: followUpMessage.tool_calls
                    });
                    // Note: This would require recursive handling, but for now we'll just log
                    console.log('[CHAT] Follow-up also requested tool calls, skipping to avoid recursion');
                }
            }
        } else if (responseMessage.content) {
            // No tool calls, just respond with text
            bot.chat(responseMessage.content);
            // Add assistant response to history
            conversationHistory.push({
                role: 'assistant',
                content: responseMessage.content
            });
        }
    } catch (error) {
        const isRateLimit = error.status === 429 || 
                           error.message?.includes('rate limit') || 
                           error.message?.includes('Rate limit') ||
                           error.code === 'rate_limit_exceeded';
        
        if (isRateLimit) {
            console.error(`[CHAT] Rate limit exceeded. Please wait before sending more messages.`);
            bot.chat('Sorry, I\'m being rate limited. Please wait a moment and try again.');
        } else {
            console.error(`[CHAT] Error processing message: ${error.message}`);
            console.error(`[CHAT] Error details:`, error);
            bot.chat(`Sorry, I encountered an error: ${error.message}`);
        }
    }
});

console.log('[INIT] Project Noël agent initialised');
console.log('[INIT] Waiting for bot connection...');

