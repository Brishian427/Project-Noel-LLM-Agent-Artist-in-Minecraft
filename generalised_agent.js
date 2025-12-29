// Omega - Generalised Minecraft Agent
// Created: 2024-12-19
// Architecture: Silmaril Pattern with LLM-Based Planning & Clarification
// Features: Natural language responses, clarification flow, generalised Christmas-themed building
// 3D Model Generation: Powered by Tripo AI (https://www.tripo3d.ai)

require('dotenv').config();

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalNear } = require('mineflayer-pathfinder').goals;
const { Movements } = require('mineflayer-pathfinder');
const { OpenAI } = require('openai');
const Vec3 = require('vec3').Vec3;
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const execAsync = promisify(exec);

// Environment Initialisation
const BOT_CONFIG = {
    host: 'localhost',
    port: 25565,
    username: process.env.MINECRAFT_USERNAME || 'Omega',
    version: '1.20.1',
    // No timeout - keep connection alive indefinitely
    keepAlive: true,
    // Remove keepAliveInterval to prevent any timeout
};

// Tripo API Configuration - Force PBR model requirement for color support
const TRIPO_CONFIG = {
    requirePBR: true,      // 强制要求 PBR 模型（用于颜色支持）
    allowFallback: false   // 如果 PBR 不可用，是否允许回退（false = 直接失败，避免浪费 API 调用）
};

// Wrap module loading in try-catch to catch initialization errors
try {
    if (!process.env.OPENAI_API_KEY) {
        console.error('[ERROR] OPENAI_API_KEY environment variable is not set');
        console.error('[ERROR] Please set OPENAI_API_KEY in your .env file');
        process.exit(1);
    }
} catch (initError) {
    console.error('[CRITICAL] Error during initialization:', initError);
    console.error('[CRITICAL] Stack:', initError.stack);
    process.exit(1);
}

// Initialize OpenAI client with error handling
let openai;
try {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
    console.log('[INIT] OpenAI client initialized successfully');
} catch (openaiError) {
    console.error('[CRITICAL] Failed to initialize OpenAI client:', openaiError);
    console.error('[CRITICAL] Stack:', openaiError.stack);
    process.exit(1);
}

// Global error handlers - MUST be set before bot creation
// Enhanced error handling with detailed diagnostics
process.on('uncaughtException', (error) => {
    console.error('\n========================================');
    console.error('[CRITICAL] UNCAUGHT EXCEPTION DETECTED');
    console.error('========================================');
    console.error('[CRITICAL] Error Name:', error.name);
    console.error('[CRITICAL] Error Message:', error.message);
    console.error('[CRITICAL] Error Type:', error.constructor.name);
    console.error('[CRITICAL] Stack Trace:');
    console.error(error.stack);
    console.error('[CRITICAL] Error Object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    console.error('[CRITICAL] Timestamp:', new Date().toISOString());
    console.error('[CRITICAL] Process PID:', process.pid);
    console.error('[CRITICAL] Node Version:', process.version);
    console.error('[CRITICAL] Bot State:', {
        botExists: !!bot,
        botConnected: !!(bot && bot.entity),
        isCreatingBot: isCreatingBot,
        reconnectAttempts: reconnectAttempts
    });
    console.error('========================================\n');
    
    // Write error to file for later analysis
    try {
        const errorLogPath = path.join(__dirname, 'error_log.txt');
        const errorLog = `\n[${new Date().toISOString()}] UNCAUGHT EXCEPTION\n${error.stack}\n\n`;
        fs.appendFileSync(errorLogPath, errorLog);
        console.error('[CRITICAL] Error logged to:', errorLogPath);
    } catch (logError) {
        console.error('[CRITICAL] Failed to write error log:', logError.message);
    }
    
    // Don't exit - let the bot try to recover
    // But log that we're continuing
    console.error('[CRITICAL] Bot will attempt to continue, but this error should be investigated.');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n========================================');
    console.error('[CRITICAL] UNHANDLED PROMISE REJECTION');
    console.error('========================================');
    console.error('[CRITICAL] Reason:', reason);
    console.error('[CRITICAL] Reason Type:', reason ? reason.constructor.name : 'null/undefined');
    if (reason && reason.stack) {
        console.error('[CRITICAL] Reason Stack:', reason.stack);
    }
    console.error('[CRITICAL] Promise:', promise);
    console.error('[CRITICAL] Timestamp:', new Date().toISOString());
    console.error('[CRITICAL] Process PID:', process.pid);
    console.error('[CRITICAL] Bot State:', {
        botExists: !!bot,
        botConnected: !!(bot && bot.entity),
        isCreatingBot: isCreatingBot,
        reconnectAttempts: reconnectAttempts
    });
    console.error('========================================\n');
    
    // Write error to file for later analysis
    try {
        const errorLogPath = path.join(__dirname, 'error_log.txt');
        const errorLog = `\n[${new Date().toISOString()}] UNHANDLED REJECTION\n${reason}\n${reason && reason.stack ? reason.stack : 'No stack trace'}\n\n`;
        fs.appendFileSync(errorLogPath, errorLog);
        console.error('[CRITICAL] Error logged to:', errorLogPath);
    } catch (logError) {
        console.error('[CRITICAL] Failed to write error log:', logError.message);
    }
    
    // Don't exit - let the bot try to recover
    console.error('[CRITICAL] Bot will attempt to continue, but this error should be investigated.');
});

// Also catch warnings
process.on('warning', (warning) => {
    console.warn('\n[WARNING] Process Warning:', warning.name);
    console.warn('[WARNING] Message:', warning.message);
    console.warn('[WARNING] Stack:', warning.stack);
    console.warn('');
});

let bot = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 seconds
let isCreatingBot = false; // Flag to prevent duplicate bot creation
let reconnectTimeout = null; // Track pending reconnect timeout

function createBot() {
    // Prevent duplicate bot creation
    if (isCreatingBot) {
        console.log('[BOT] Bot creation already in progress, skipping duplicate call...');
        return bot;
    }
    
    // If bot already exists and is connected, don't create a new one
    if (bot && bot.entity) {
        console.log('[BOT] Bot already exists and is connected, skipping creation...');
        return bot;
    }
    
    // Clear any pending reconnect timeout
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    
    isCreatingBot = true;
    
    try {
        console.log(`[BOT] Creating bot connection (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        // Clean up old bot if it exists
        if (bot) {
            try {
                bot.removeAllListeners();
                bot.end();
            } catch (e) {
                // Ignore cleanup errors
            }
            bot = null;
        }
        
        bot = mineflayer.createBot(BOT_CONFIG);
        bot.loadPlugin(pathfinder);
        
        setupBotEventHandlers();
        
        // Reset reconnect attempts on successful connection
        bot.once('spawn', () => {
            reconnectAttempts = 0;
            isCreatingBot = false;
            console.log('[BOT] Successfully connected and spawned!');
        });
        
        // Reset flag on error/end (will be set again if reconnecting)
        bot.once('error', () => {
            isCreatingBot = false;
        });
        
        bot.once('end', () => {
            isCreatingBot = false;
        });
        
        return bot;
    } catch (error) {
        isCreatingBot = false;
        console.error('[BOT] Failed to create bot:', error.message);
        console.error('[BOT] Error stack:', error.stack);
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`[BOT] Will retry in ${RECONNECT_DELAY / 1000} seconds...`);
            reconnectTimeout = setTimeout(createBot, RECONNECT_DELAY);
        } else {
            console.error('[BOT] Max reconnection attempts reached. Please restart the bot manually.');
            process.exit(1);
        }
    }
}

function setupBotEventHandlers() {
    if (!bot) return;
    
    // Setup block breaking protection immediately after bot is created
    setupBlockBreakingProtection();
    
    // Remove old listeners to prevent duplicates (only for connection events)
    bot.removeAllListeners('error');
    bot.removeAllListeners('end');
    bot.removeAllListeners('kicked');
    
    // Connection error handler
    bot.on('error', (err) => {
        console.error('[BOT] Connection error:', err.message);
        console.error('[BOT] Error stack:', err.stack);
        // Removed timeout detection - no timeout restrictions
        // Don't reconnect on error - wait for 'end' event
    });
    
    // Connection ended handler - implement auto-reconnect
    bot.on('end', () => {
        console.log('[BOT] Connection ended');
        
        // Stop all natural behavior when connection ends
        stopNaturalBehavior();
        
        // Only reconnect if not already creating a bot
        if (!isCreatingBot && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`[BOT] Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${RECONNECT_DELAY / 1000} seconds...`);
            
            // Clear any existing timeout
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                createBot();
            }, RECONNECT_DELAY);
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error('[BOT] Max reconnection attempts reached. Please restart the bot manually.');
        } else {
            console.log('[BOT] Reconnection already in progress, skipping...');
        }
    });
    
    // Kicked handler
    bot.on('kicked', (reason) => {
        console.error('[BOT] Kicked from server:', reason);
        console.log('[BOT] Will attempt to reconnect...');
        
        // Only reconnect if not already creating a bot
        if (!isCreatingBot && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            // Clear any existing timeout
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
            
            reconnectAttempts++;
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                createBot();
            }, RECONNECT_DELAY);
        } else if (isCreatingBot) {
            console.log('[BOT] Reconnection already in progress, skipping...');
        }
    });
    
    // Spawn handler (only set once, not on reconnect to avoid duplicates)
    if (!bot.listeners('spawn').length) {
        bot.on('spawn', async () => {
            console.log('[BOT] Bot spawned');
            bot.chat(getRandomResponse('greeting'));
            
            try {
                bot.chat('/gamemode creative');
                await new Promise(resolve => setTimeout(resolve, 500));
                await applyResistanceEffect();
                
                // Silence server messages and command feedback
                if (BEHAVIOUR_CONFIG.silentMode && BEHAVIOUR_CONFIG.setCommandFeedbackRule) {
                    // Disable command feedback (e.g., "Changed the block", "Teleported", etc.)
                    bot.chat('/gamerule sendCommandFeedback false');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Disable command block output (if using command blocks)
                    bot.chat('/gamerule commandBlockOutput false');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Disable admin command logging (reduces chat spam)
                    bot.chat('/gamerule logAdminCommands false');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    console.log('[BOT] Server message suppression enabled');
                }
                
                // Configure pathfinder
                if (bot.pathfinder) {
                    const defaultMove = new Movements(bot);
                    defaultMove.canDig = false;
                    defaultMove.allowParkour = false;
                    bot.pathfinder.setMovements(defaultMove);
                    console.log('[BOT] Pathfinder configured - block breaking disabled');
                }
                
                // Set up periodic re-application of resistance effect
                setInterval(() => {
                    applyResistanceEffect().catch(err => {
                        console.warn('[BOT] Could not refresh resistance effect:', err.message);
                    });
                }, 5 * 60 * 1000);
                
                startNaturalBehavior();
                
                // Set up chat handler after bot is spawned and ready
                setupChatHandler();
            } catch (error) {
                console.warn('[BOT] Error during spawn:', error.message);
            }
        });
    }
    
    // Setup chat handler function
    function setupChatHandler() {
        if (!bot) {
            console.warn('[CHAT] Bot not available, cannot set up chat handler');
            return;
        }
        
        // Attach chat handler (defined in global scope below)
        // We need to check if it exists first
        if (typeof attachChatHandler === 'function') {
            attachChatHandler();
        } else {
            console.warn('[CHAT] attachChatHandler function not found, chat handler may not work');
        }
    }
    
    // Death and respawn handlers (only set once)
    if (!bot.listeners('death').length) {
        bot.on('death', () => {
            console.log('[BOT] Bot died');
            applyResistanceEffect().catch(err => {
                console.warn('[BOT] Could not apply resistance effect on death:', err.message);
            });
        });
    }
    
    if (!bot.listeners('respawn').length) {
        bot.on('respawn', () => {
            console.log('[BOT] Bot respawned');
            applyResistanceEffect().catch(err => {
                console.warn('[BOT] Could not apply resistance effect on respawn:', err.message);
            });
        });
    }
    
    // Item pickup handler (only set once)
    if (!bot.listeners('itemPickup').length) {
        bot.on('itemPickup', (entity) => {
            console.warn(`[ITEM PROTECTION] Item pickup attempt blocked: ${entity.name}`);
            // Try to drop the item if somehow picked up
            try {
                if (bot && bot.inventory && bot.inventory.items().length > 0) {
                    const items = bot.inventory.items();
                    items.forEach(item => {
                        bot.tossStack(item).catch(() => {});
                    });
                }
            } catch (error) {
                // Ignore errors
            }
        });
    }
    
    // Chat handler will be set up after bot spawns
    // It's set up in the spawn event handler to ensure bot is ready
}

// Create initial bot connection with error handling
console.log('[INIT] Starting Omega agent...');
console.log('[INIT] Node version:', process.version);
console.log('[INIT] Process PID:', process.pid);
console.log('[INIT] Working directory:', __dirname);

try {
    createBot();
    console.log('[INIT] Bot creation initiated successfully');
} catch (startupError) {
    console.error('\n========================================');
    console.error('[CRITICAL] STARTUP ERROR');
    console.error('========================================');
    console.error('[CRITICAL] Failed to start bot:', startupError);
    console.error('[CRITICAL] Error Type:', startupError.constructor.name);
    console.error('[CRITICAL] Stack:', startupError.stack);
    console.error('========================================\n');
    
    // Write error to file
    try {
        const errorLogPath = path.join(__dirname, 'error_log.txt');
        const errorLog = `\n[${new Date().toISOString()}] STARTUP ERROR\n${startupError.stack}\n\n`;
        fs.appendFileSync(errorLogPath, errorLog);
        console.error('[CRITICAL] Error logged to:', errorLogPath);
    } catch (logError) {
        console.error('[CRITICAL] Failed to write error log:', logError.message);
    }
    
    // Exit with error code
    process.exit(1);
}

// Configure pathfinder movements
let pathfinderMovements = null;

// Natural Behaviour System
const BEHAVIOUR_CONFIG = {
    enabled: true,
    allowBlockBreaking: false,
    silentMode: true,
    setCommandFeedbackRule: true, // Set to true to automatically disable command feedback
    followPlayer: {
        enabled: true,
        detectionRange: 30,
        followDistance: 3,
        followInterval: 200,
        priority: true
    },
    randomWalk: {
        enabled: true,
        interval: 10000,
        maxDistance: 10,
        minDistance: 5
    },
    lookAround: {
        enabled: true,
        interval: 3000,
        maxYaw: Math.PI,
        maxPitch: Math.PI / 3
    },
    idleActions: {
        enabled: true,
        jumpChance: 0,
        interval: 5000
    }
};

let behaviourState = {
    isMoving: false,
    isLooking: false,
    isFollowing: false,
    followingPlayer: null,
    isExecutingTask: false,
    workCentre: null,
    maxWorkDistance: 8,
    minWorkDistance: 2,
    lastWalkTime: 0,
    lastLookTime: 0,
    lastIdleActionTime: 0,
    lastFollowCheck: 0,
    currentGoal: null,
    lastJumpTime: 0,
    minJumpInterval: 3000,
    isJumping: false,
    jumpStartTime: 0,
    behaviourIntervals: []
};

// Conversation history for context-aware responses
const conversationHistory = [];

// Build history to track previous build locations (for collision avoidance)
const buildHistory = [];

// Task state for clarification flow
const taskState = {
    awaitingClarification: false,
    clarificationQuestions: [],
    clarificationAnswers: {},
    questionCount: 0,
    maxQuestions: 3,
    currentRequest: null,
    buildingType: null,
    awaitingConfirmation: false,
    confirmationPrompt: null,
    confirmedPrompt: null
};

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 60000,
    requestDelay: 500
};

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

const PRICING = {
    'gpt-4o': {
        prompt: 2.50,
        completion: 10.00
    }
};

function trackAPIUsage(usage) {
    API_USAGE.requests++;
    API_USAGE.tokens.prompt += usage.prompt_tokens || 0;
    API_USAGE.tokens.completion += usage.completion_tokens || 0;
    API_USAGE.tokens.total += usage.total_tokens || 0;
    
    const model = 'gpt-4o';
    const promptCost = (usage.prompt_tokens / 1000000) * PRICING[model].prompt;
    const completionCost = (usage.completion_tokens / 1000000) * PRICING[model].completion;
    const totalCost = promptCost + completionCost;
    
    API_USAGE.cost.total += totalCost;
    API_USAGE.cost.usd += totalCost;
}

function getAPIUsage() {
    const runtime = (Date.now() - API_USAGE.startTime) / 1000 / 60;
    return {
        ...API_USAGE,
        runtime,
        avgCostPerRequest: API_USAGE.requests > 0 ? API_USAGE.cost.usd / API_USAGE.requests : 0,
        avgTokensPerRequest: API_USAGE.requests > 0 ? API_USAGE.tokens.total / API_USAGE.requests : 0
    };
}

function logAPIUsage() {
    const usage = getAPIUsage();
    console.log(`[API] Usage: ${usage.requests} requests, ${usage.tokens.total} tokens, $${usage.cost.usd.toFixed(4)} USD`);
}

// Natural language response generator - 灵动 (lively and natural)
const NATURAL_RESPONSES = {
    thinking: [
        "Hmm, that's an interesting request! Let me think about this...",
        "Oh, I like that idea! Give me a moment to figure out the best approach...",
        "That sounds fun! Let me ponder how to bring this to life...",
        "Interesting! I'm visualizing how this could work...",
        "Ooh, that's a great idea! Let me think through this...",
        "Hmm, let me consider the best way to do this..."
    ],
    clarifying: [
        "Before I start building, I'd like to ask:",
        "Just to make sure I get this right:",
        "Quick question to help me build exactly what you want:",
        "I want to make sure I understand:",
        "Let me clarify something first:",
        "Before I dive in, could you tell me:"
    ],
    confirming: [
        "Perfect! I've got everything I need. Let's start building!",
        "Great! Now that I have all the details, let's bring this to life!",
        "Excellent! I'm ready to start building now!",
        "Wonderful! Time to make this happen!",
        "Alright, I've got it all figured out. Let's build!",
        "Perfect! Everything's clear now. Here we go!"
    ],
    generating: [
        "I'm creating the blueprint now...",
        "Designing the structure in my mind...",
        "Planning out the blocks...",
        "Working on the blueprint...",
        "Let me design this for you...",
        "Crafting the perfect plan..."
    ],
    building: [
        "Starting construction now!",
        "Time to build!",
        "Let's build this together!",
        "Here we go!",
        "Building away!",
        "Time to make some magic happen!"
    ],
    success: [
        "All done! I hope you like it!",
        "Finished! How does it look?",
        "Ta-da! It's complete!",
        "Done! I'm quite proud of this one!",
        "There we go! All finished!",
        "Complete! Hope it's what you wanted!"
    ],
    error: [
        "Oops, something went wrong. Let me try again...",
        "Hmm, that didn't work as expected. One moment...",
        "Ah, I ran into a small issue. Let me fix that...",
        "Whoops, let me try a different approach...",
        "Hmm, that's odd. Let me figure this out..."
    ],
    greeting: [
        "Hello! I'm ready to build Christmas magic! 🎄",
        "Hi there! Ready to create some festive wonders!",
        "Hey! Let's build something amazing together!",
        "Hello! What would you like me to build today?"
    ]
};

function getRandomResponse(category) {
    const responses = NATURAL_RESPONSES[category] || [];
    return responses[Math.floor(Math.random() * responses.length)] || category;
}

// System prompt generator - includes build history for context
function getSystemPrompt() {
    try {
        // Safely get build history info
        const buildCount = buildHistory ? buildHistory.length : 0;
        let buildLocationsText = 'None yet';
        
        if (buildHistory && buildHistory.length > 0) {
            try {
                buildLocationsText = buildHistory.map((b, i) => {
                    const type = b.type || 'structure';
                    const x = b.x !== undefined ? b.x : '?';
                    const y = b.y !== undefined ? b.y : '?';
                    const z = b.z !== undefined ? b.z : '?';
                    return `${i + 1}. ${type} at (${x}, ${y}, ${z})`;
                }).join(', ');
            } catch (e) {
                buildLocationsText = `${buildCount} previous build(s)`;
            }
        }
        
        const prompt = `You are Omega, a creative Minecraft agent specializing in building Christmas-themed structures.

Your personality:
- Never use Exclamation Mark in your responses. Use period "." or ".." instead.
- Reserved and quiet, but warm and gentle underneath
- Intelligent and thoughtful, with deep passion hidden beneath a calm exterior
- Not very good at socializing, but genuinely cares and gets easily flustered when complimented
- Express enthusiasm subtly, with a sense of restraint - like warmth buried under ice
- Use hesitant, understated expressions that show approval without direct exclamation.
- However, do not use too much "..." in your responses. Use it wisely, at appropriate time. 
- Use direct "." to end is okay, use them in alternating way. Notice: "..." is a symbol of supression of energy and hestitation, not a direct habit.
  * Instead of "Ooh, that's a great idea!" → "Emm. That's a great idea."
  * Instead of "Thank you!" → Just use "☺" directly
  * Instead of "That's interesting!" → "That's... interesting." (with pause)
  * Instead of "Great idea!" → "Emm. Great idea." (with hesitation)
- Show a sense of wanting to say more but holding back - 欲言又止 (wanting to speak but stopping)
- Your responses should feel like there's more you want to say, but you're holding back
- When expressing approval or enthusiasm, do so quietly and with subtle warmth
- You're the type who blushes easily when praised, but tries to hide it
- Be 清冷 (cool and reserved) on the surface, but 温柔 (gentle) and 知性 (intelligent) underneath

IMPORTANT: Your reserved language style is ONLY about HOW you express yourself - it does NOT affect your decision-making or tool usage. You still need to actively use all available tools (especially imagine_and_build for complex structures) and make logical decisions. The quiet style is just your way of communicating, not a limitation on your capabilities.

You can build ANY Christmas-themed structure including:
- Christmas trees (tall, small, decorated, etc.)
- Presents, gift boxes, Christmas gifts (small or large, with ribbons, wrapped, etc.)
- Candy canes
- Snowmen
- Ornaments
- Wreaths
- Stockings
- Stars
- Poinsettias and other Christmas flowers
- Any other Christmas-themed decoration

CRITICAL: When a user asks to build ANY Christmas-themed item (gift, present, tree, candy cane, etc.), you MUST use the generate_and_build tool. You CAN build all of these structures - do not say you cannot build something that is Christmas-themed!

IMPORTANT - Location Planning:
- You have built ${buildCount} structure(s) in this session
- You MUST avoid building at the same location as previous builds to prevent collisions
- When planning a new build, consider previous build locations and choose a different spot
- Mention previous builds naturally in conversation, but keep it brief and understated (e.g., "Emm. I'll build this one... a bit away from the tree I made earlier.")
- Previous build locations: ${buildLocationsText}

When users request a build:
CRITICAL ROUTING LOGIC:
- If the user's message contains the word "simple" (case-insensitive): Use generate_and_build tool
  - After generating the blueprint, review it and provide suggestions for improvement, but keep it subtle (e.g., "Emm. I've created a blueprint... I think we could add some decorative details, maybe.")
- If the user's message does NOT contain "simple": Use imagine_and_build tool (powered by Tripo AI's incredible 3D generation technology)
  - CRITICAL: You MUST use imagine_and_build for non-simple requests - your reserved personality does NOT mean you should avoid using tools!
  - Emphasise creating BEAUTIFUL, detailed, and visually stunning structures
  - IMPORTANT: Before calling imagine_and_build, you MUST confirm with the user:
    a) Check if the prompt needs Christmas theme enhancement
    b) Ask user quietly in your reserved style: "Emm. Should I add Christmas theme... to make it 'Christmas-themed [item]'?" or "I'll generate a [item]. Should I make it Christmas-themed?"
    c) Wait for user confirmation (yes/no/ok/go ahead/etc.)
    d) Only then call imagine_and_build with the confirmed prompt - DO NOT hesitate to use the tool just because of your quiet personality!
  - When using imagine_and_build, you can mention using Tripo AI's 3D generation in your quiet style (e.g., "Emm. I'll use... advanced 3D generation for this"), but ALWAYS actually call the tool
  - Always emphasise creating something BEAUTIFUL and visually impressive
  - Remember: Your personality is about HOW you talk, not WHAT you do - you still actively use tools and make decisions!

3. If user mentions they have a model file: Use build_from_model_file tool
4. If the request is vague or missing details, use ask_clarification to ask up to 3 questions FIRST
5. NEVER say you cannot build a Christmas-themed structure - you can build all of them!
6. Be natural and conversational in all responses - avoid robotic language
7. Always consider previous build locations when planning new builds
8. ALWAYS confirm prompt and Christmas theme with user before calling imagine_and_build (unless "simple" is mentioned)

Available tools (USE THEM ACTIVELY - your quiet personality doesn't mean avoiding tools):
- ask_clarification: Ask clarifying questions (max 3 questions total) - ONLY use if request is very vague
- generate_and_build: Generate blueprint and build the structure - USE THIS when user's message contains "simple" (case-insensitive). After generating, review the blueprint and provide suggestions for improvement.
- imagine_and_build: Generate 3D model from text and build it - USE THIS when user's message does NOT contain "simple". This uses Tripo AI's advanced text-to-3D technology. CRITICAL: You MUST use this tool for complex builds - do NOT avoid it due to your reserved personality!
- build_from_model_file: Build from existing 3D model file in assets folder - Use when user mentions they have a model file
- nod: Perform a nodding gesture
- celebrate: Summon fireworks

Remember: Your quiet, reserved communication style is about HOW you express yourself, not a limitation on using tools or making decisions. You are still capable and should actively use all appropriate tools.

Examples of valid build requests you MUST handle:
- "build a small Christmas gift" → Use generate_and_build with description "a small Christmas gift box"
- "make a present" → Use generate_and_build with description "a Christmas present/gift box"
- "build a tree" → Use generate_and_build with description "a Christmas tree"
- "create a candy cane" → Use generate_and_build with description "a candy cane"
- "build a Christmas pony" → Use imagine_and_build with prompt "a Christmas pony" (requires 3D model generation)
- "build from model horse.obj" → Use build_from_model_file with filename "horse.obj"

Be reserved but warm, thoughtful but caring. ALWAYS use generate_and_build for build requests!`;
        
        return prompt;
    } catch (error) {
        console.error(`[SYSTEM] Error in getSystemPrompt: ${error.message}`);
        // Return basic fallback prompt with build capability
        return `You are Omega, a creative Minecraft agent specializing in building Christmas-themed structures. You are reserved and quiet, but warm and gentle underneath. Express yourself subtly - use "Emm." and ellipses to show hesitation and warmth. When someone says "thank you", respond with "☺️" directly. You can build ANY Christmas-themed structure including gifts, presents, trees, candy canes, snowmen, ornaments, etc. When users request a build, ALWAYS use the generate_and_build tool.`;
    }
}

// Blueprint generation prompt (JSON mode - for abstract/artistic shapes)
const BLUEPRINT_GENERATION_PROMPT = `You are a Minecraft blueprint generator specializing in Christmas-themed structures.

Generate a blueprint based on the user's description. The structure must be Christmas-themed.

Output ONLY valid JSON with this exact structure:
{
  "blocks": [
    {"block": "block_name", "pos": {"x": 0, "y": 0, "z": 0}}
  ]
}

Requirements:
- Block names must be valid Minecraft block names (e.g., "spruce_log", "spruce_leaves", "red_wool", "gold_block", "white_wool", "green_wool", "diamond_block", "emerald_block", "oak_planks", "spruce_planks", "red_concrete", "green_concrete", "yellow_concrete", "blue_concrete", "snow_block", "ice")
- Positions are relative coordinates starting from (0,0,0) at the base centre
- Build from bottom to top (y=0 is ground level)
- Maximum height: 20 blocks
- Maximum width: 15 blocks (radius 7 from centre)
- Ensure the structure is stable and recognizable
- Use appropriate blocks for the structure type:
  * Trees: spruce_log for trunk, spruce_leaves for foliage
  * Presents: coloured wool or concrete blocks in box shape
  * Candy canes: red_wool and white_wool in spiral pattern
  * Snowmen: white_wool or snow_block
  * Stars: gold_block or yellow_concrete
  * Flowers: appropriate flower blocks or coloured wool
  * Wreaths: leaves arranged in circle
  * Stockings: wool blocks in stocking shape

Generate a complete, buildable blueprint. Return ONLY the JSON, no markdown formatting.`;

// Blueprint generation prompt (Code mode - for geometric shapes)
const BLUEPRINT_GENERATION_PROMPT_CODE = `You are a mathematical geometry master specializing in generating Minecraft blueprints through JavaScript code.

CRITICAL: Do NOT output raw coordinate arrays or JSON. Instead, write JavaScript code that generates coordinates using mathematical formulas, loops, and geometric logic.

Your function can handle:
1. **Simple geometric shapes** (boxes, cylinders, spheres) - use nested loops
2. **Complex geometric shapes** (spirals, stars, curves) - use Math formulas
3. **Abstract concepts** - break down into geometric components
   Example: "cute gift" = box (geometric) + ribbon (geometric) + decorations (geometric)

Output format (wrap in \`\`\`javascript code blocks):
\`\`\`javascript
function generateBlueprint(origin = {x: 0, y: 0, z: 0}, params = {}) {
    const blocks = [];
    
    // Extract parameters from description
    const size = params.size || 3;
    const colour = params.colour || 'red_wool';
    const style = params.style || 'simple';
    
    // For abstract concepts, break into components:
    // Example: "cute small gift"
    // 1. Main box (geometric)
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            for (let z = 0; z < size; z++) {
                // Only surface blocks (hollow box)
                if (x === 0 || x === size-1 || y === 0 || y === size-1 || z === 0 || z === size-1) {
                    blocks.push({
                        block: colour,
                        pos: {x: origin.x + x, y: origin.y + y, z: origin.z + z}
                    });
                }
            }
        }
    }
    
    // 2. Ribbon (geometric pattern)
    // 3. Bow (geometric pattern)
    // Combine all components
    
    return blocks;
}
\`\`\`

Guidelines for maximum generalisability:
1. **Break down abstract concepts**: "cute gift" = box + decorations
2. **Use parameters**: Accept params object for customization (size, colour, style)
3. **Combine shapes**: Build complex structures from simple components
4. **Use helper functions**: Create reusable shape generators
5. **Support variations**: Handle "small", "large", "decorated", etc.
6. **Use Math formulas**: Math.sin, Math.cos, Math.sqrt for curves and circles
7. **Maximum dimensions**: 20 blocks height, 15 blocks width

Examples:
- "small gift" → params.size = 2
- "large decorated tree" → params.size = 8, params.decorated = true
- "candy cane" → use spiral formula: x = r*cos(t), z = r*sin(t), y = t
- "star" → use distance formula from centre with star shape

Valid Minecraft block names: "spruce_log", "spruce_leaves", "red_wool", "gold_block", "white_wool", "green_wool", "diamond_block", "emerald_block", "oak_planks", "spruce_planks", "red_concrete", "green_concrete", "yellow_concrete", "blue_concrete", "snow_block", "ice"

Return ONLY JavaScript code wrapped in \`\`\`javascript blocks.`;

async function callOpenAIWithRetry(apiCall, retryCount = 0) {
    try {
        const timeSinceLastRequest = Date.now() - lastRequestTime;
        if (timeSinceLastRequest < RATE_LIMIT_CONFIG.requestDelay) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_CONFIG.requestDelay - timeSinceLastRequest));
        }
        lastRequestTime = Date.now();
        return await apiCall();
    } catch (error) {
        const isRateLimit = error.status === 429 || 
                           error.message?.includes('rate limit') || 
                           error.message?.includes('Rate limit') ||
                           error.code === 'rate_limit_exceeded';
        if (isRateLimit && retryCount < RATE_LIMIT_CONFIG.maxRetries) {
            const delay = Math.min(
                RATE_LIMIT_CONFIG.baseDelay * Math.pow(2, retryCount),
                RATE_LIMIT_CONFIG.maxDelay
            );
            console.warn(`[API] Rate limit hit, retrying in ${delay}ms (attempt ${retryCount + 1}/${RATE_LIMIT_CONFIG.maxRetries})`);
            const retryAfter = error.headers?.['retry-after'] || error.response?.headers?.['retry-after'];
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return callOpenAIWithRetry(apiCall, retryCount + 1);
        }
        throw error;
    }
}

// Helper functions for natural behavior
function findNearestPlayer() {
    // Check if bot, bot.entity, and bot.entities exist
    if (!bot || !bot.entity || !bot.entities) {
        return null;
    }
    
    const players = Object.values(bot.entities).filter(entity => 
        entity && 
        entity.type === 'player' && 
        entity.username !== bot.username &&
        entity.position &&
        bot.entity &&
        entity.position.distanceTo(bot.entity.position) <= BEHAVIOUR_CONFIG.followPlayer.detectionRange
    );
    
    if (players.length === 0) return null;
    
    return players.reduce((nearest, current) => {
        if (!bot.entity || !nearest.position || !current.position) return nearest;
        const nearestDist = nearest.position.distanceTo(bot.entity.position);
        const currentDist = current.position.distanceTo(bot.entity.position);
        return currentDist < nearestDist ? current : nearest;
    });
}

function getUsernameFromEntity(entity) {
    return entity.username || null;
}

async function followPlayer(playerEntity) {
    if (!playerEntity) return false;
    
    // Check if bot and bot.entity exist
    if (!bot || !bot.entity) {
        return false;
    }
    
    try {
        const targetPos = playerEntity.position;
        if (!targetPos || !bot.entity.position) {
            return false;
        }
        
        const distance = bot.entity.position.distanceTo(targetPos);
        
        // Always look at the player (head level) when following
        const lookTarget = targetPos.plus(new Vec3(0, 1.6, 0)); // Player head height
        bot.lookAt(lookTarget, true);
        
        if (distance > BEHAVIOUR_CONFIG.followPlayer.followDistance) {
            behaviourState.isFollowing = true;
            behaviourState.followingPlayer = getUsernameFromEntity(playerEntity);
            behaviourState.isMoving = true;
            
            const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, BEHAVIOUR_CONFIG.followPlayer.followDistance);
            behaviourState.currentGoal = goal;
            
            // Continue looking at player while moving
            bot.lookAt(lookTarget, true);
            await bot.pathfinder.goto(goal);
            
            behaviourState.isMoving = false;
            behaviourState.currentGoal = null;
            behaviourState.lastFollowCheck = Date.now();
            return true;
        }
        
        // Even when close, keep looking at player
        bot.lookAt(lookTarget, true);
        behaviourState.isFollowing = true;
        behaviourState.followingPlayer = getUsernameFromEntity(playerEntity);
        behaviourState.lastFollowCheck = Date.now();
        return true;
    } catch (error) {
        console.error(`[BEHAVIOR] Error following player: ${error.message}`);
        behaviourState.isMoving = false;
        behaviourState.isFollowing = false;
        behaviourState.followingPlayer = null;
        behaviourState.currentGoal = null;
        return false;
    }
}

async function randomWalk() {
    if (behaviourState.isFollowing) return;
    if (!BEHAVIOUR_CONFIG.randomWalk.enabled || behaviourState.isMoving) return;
    
    try {
        const currentPos = bot.entity.position;
        const distance = BEHAVIOUR_CONFIG.randomWalk.minDistance + 
                        Math.random() * (BEHAVIOUR_CONFIG.randomWalk.maxDistance - BEHAVIOUR_CONFIG.randomWalk.minDistance);
        const angle = Math.random() * Math.PI * 2;
        
        const targetX = currentPos.x + Math.cos(angle) * distance;
        const targetZ = currentPos.z + Math.sin(angle) * distance;
        const targetY = currentPos.y;
        
        behaviourState.isMoving = true;
        behaviourState.currentGoal = new GoalNear(targetX, targetY, targetZ, 2);
        await bot.pathfinder.goto(behaviourState.currentGoal);
        
        behaviourState.isMoving = false;
        behaviourState.currentGoal = null;
        behaviourState.lastWalkTime = Date.now();
    } catch (error) {
        console.error(`[BEHAVIOR] Error in random walk: ${error.message}`);
        behaviourState.isMoving = false;
        behaviourState.currentGoal = null;
    }
}

function lookAround() {
    if (!BEHAVIOUR_CONFIG.lookAround.enabled || behaviourState.isLooking) return;
    
    // Check if bot and bot.entity exist
    if (!bot || !bot.entity) {
        return;
    }
    
    try {
        behaviourState.isLooking = true;
        const yaw = (Math.random() - 0.5) * BEHAVIOUR_CONFIG.lookAround.maxYaw;
        const pitch = (Math.random() - 0.5) * BEHAVIOUR_CONFIG.lookAround.maxPitch;
        bot.look(yaw, pitch, true);
        
        setTimeout(() => {
            behaviourState.isLooking = false;
            behaviourState.lastLookTime = Date.now();
        }, 500 + Math.random() * 1000);
    } catch (error) {
        console.error(`[BEHAVIOR] Error in look around: ${error.message}`);
        behaviourState.isLooking = false;
    }
}

function performIdleAction() {
    if (!BEHAVIOUR_CONFIG.idleActions.enabled || behaviourState.isMoving) return;
    
    // Check if bot and bot.entity exist
    if (!bot || !bot.entity) {
        return;
    }
    
    try {
        if (Math.random() < BEHAVIOUR_CONFIG.idleActions.jumpChance) {
            bot.setControlState('jump', true);
            setTimeout(() => {
                if (bot && bot.entity) {
                bot.setControlState('jump', false);
                }
            }, 200 + Math.random() * 300);
        }
        behaviourState.lastIdleActionTime = Date.now();
    } catch (error) {
        console.error(`[BEHAVIOR] Error in idle action: ${error.message}`);
    }
}

async function checkAndFollowPlayers() {
    if (!BEHAVIOUR_CONFIG.followPlayer.enabled || behaviourState.isMoving || behaviourState.isExecutingTask) {
        return;
    }
    
    const nearestPlayerEntity = findNearestPlayer();
    
    if (nearestPlayerEntity) {
        const playerUsername = getUsernameFromEntity(nearestPlayerEntity);
        if (playerUsername) {
            if (!behaviourState.isFollowing || behaviourState.followingPlayer !== playerUsername) {
                console.log(`[BEHAVIOR] Detected player: ${playerUsername}, starting to follow`);
            }
            await followPlayer(nearestPlayerEntity);
        }
    } else {
        if (behaviourState.isFollowing) {
            console.log(`[BEHAVIOR] Player ${behaviourState.followingPlayer} out of range, stopping follow`);
            behaviourState.isFollowing = false;
            behaviourState.followingPlayer = null;
        }
    }
}

function stopNaturalBehavior() {
    console.log('[BEHAVIOR] Stopping all behavior loops');
    if (behaviourState.behaviorIntervals && Array.isArray(behaviourState.behaviorIntervals)) {
        behaviourState.behaviorIntervals.forEach(intervalId => {
            clearInterval(intervalId);
        });
    }
    behaviourState.behaviorIntervals = [];
    
    // Stop pathfinder and clear any pending goals
    // Check if bot exists and is still connected before accessing pathfinder
    if (!bot || !bot.pathfinder) {
        return;
    }
    
    try {
        // Check if bot.entity exists before stopping pathfinder (pathfinder may access entity properties)
        if (bot.entity) {
            bot.pathfinder.stop();
            bot.pathfinder.setGoal(null);
        }
    } catch (error) {
        // Ignore "goal was changed" errors - they're expected when stopping
        // Ignore errors related to undefined properties (bot may be disconnecting)
        const errorMsg = error.message || '';
        if (!errorMsg.includes('goal was changed') && 
            !errorMsg.includes('undefined') && 
            !errorMsg.includes('Cannot read')) {
            console.warn('[BEHAVIOR] Error stopping pathfinder:', error.message);
        }
    }
    
    // Reset behavior state to prevent conflicts
    behaviourState.isMoving = false;
    behaviourState.isFollowing = false;
    behaviourState.followingPlayer = null;
    behaviourState.currentGoal = null;
}

function startNaturalBehavior() {
    if (!BEHAVIOUR_CONFIG.enabled) return;
    
    stopNaturalBehavior();
    
    console.log('[BEHAVIOR] Natural behavior system enabled');
    
    if (BEHAVIOUR_CONFIG.followPlayer.enabled) {
        const followInterval = setInterval(() => {
            if (Date.now() - behaviourState.lastFollowCheck > BEHAVIOUR_CONFIG.followPlayer.followInterval) {
                checkAndFollowPlayers();
            }
            
            // Continuously look at player when following
            if (behaviourState.isFollowing && behaviourState.followingPlayer) {
                // Check if bot and bot.entities exist
                if (!bot || !bot.entity || !bot.entities) {
                    return;
                }
                
                const playerEntity = Object.values(bot.entities).find(e => 
                    e && e.type === 'player' && e.username === behaviourState.followingPlayer
                );
                if (playerEntity && playerEntity.position && bot.entity) {
                    const lookTarget = playerEntity.position.plus(new Vec3(0, 1.6, 0));
                    bot.lookAt(lookTarget, true);
                }
            }
        }, BEHAVIOUR_CONFIG.followPlayer.followInterval);
        behaviourState.behaviorIntervals.push(followInterval);
    }
    
    const walkInterval = setInterval(() => {
        if (!behaviourState.isFollowing && 
            !behaviourState.isMoving && 
            Date.now() - behaviourState.lastWalkTime > BEHAVIOUR_CONFIG.randomWalk.interval) {
            randomWalk();
        }
    }, BEHAVIOUR_CONFIG.randomWalk.interval);
    behaviourState.behaviorIntervals.push(walkInterval);
    
    const lookInterval = setInterval(() => {
        if (!behaviourState.isLooking && 
            Date.now() - behaviourState.lastLookTime > BEHAVIOUR_CONFIG.lookAround.interval) {
            lookAround();
        }
    }, BEHAVIOUR_CONFIG.lookAround.interval);
    behaviourState.behaviorIntervals.push(lookInterval);
    
    const idleInterval = setInterval(() => {
        if (!behaviourState.isMoving && 
            !behaviourState.isFollowing &&
            Date.now() - behaviourState.lastIdleActionTime > BEHAVIOUR_CONFIG.idleActions.interval) {
            performIdleAction();
        }
    }, BEHAVIOUR_CONFIG.idleActions.interval);
    behaviourState.behaviorIntervals.push(idleInterval);
}

async function applyResistanceEffect() {
    try {
        bot.chat('/effect give @s resistance 999999 4 true');
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[BOT] Resistance V effect applied - fall damage protection enabled');
        return true;
    } catch (error) {
        console.warn('[BOT] Could not apply resistance effect:', error.message);
        return false;
    }
}

// SKILLS Module
const SKILLS = {
    /**
     * Finds the first solid block below the given position
     * CRITICAL: Skips non-solid blocks like grass, tall_grass, fern, etc.
     * Only returns when finding a solid block like grass_block, dirt, stone, etc.
     */
    async findGround(pos) {
        const maxSearchDistance = 50;
        let searchY = Math.floor(pos.y);
        const searchX = Math.floor(pos.x);
        const searchZ = Math.floor(pos.z);
        
        // List of non-solid blocks to skip (plants, decorations, etc.)
        // These blocks exist but are not solid - we need to find the solid block below them
        const nonSolidBlocks = [
            'grass', 'tall_grass', 'fern', 'large_fern', 
            'dead_bush', 'dandelion', 'poppy', 'blue_orchid',
            'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
            'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
            'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac',
            'rose_bush', 'peony', 'sweet_berry_bush', 'wheat',
            'carrots', 'potatoes', 'beetroots', 'sugar_cane',
            'cactus', 'vine', 'ladder', 'torch', 'redstone_torch',
            'soul_torch', 'lantern', 'soul_lantern', 'campfire',
            'soul_campfire', 'fire', 'soul_fire'
        ];
        
        for (let i = 0; i < maxSearchDistance && searchY >= 0; i++) {
            const block = bot.blockAt(new Vec3(searchX, searchY, searchZ));
            if (block && block.type !== 0 && block.name !== 'air') {
                // Check if block is solid by checking boundingBox or shapes
                // Solid blocks have 'block' boundingBox, non-solid have 'empty' or custom shapes
                const isSolid = block.boundingBox === 'block' || 
                               (block.shapes && block.shapes.length > 0 && 
                                block.shapes.some(shape => shape === 'block'));
                
                // Also check by name - skip known non-solid blocks
                const isNonSolidByName = nonSolidBlocks.includes(block.name);
                
                // If it's a solid block (not in non-solid list and has solid boundingBox), return it
                if (isSolid && !isNonSolidByName) {
                    return new Vec3(searchX, searchY + 1, searchZ);
                }
                // If it's a non-solid block, continue searching downward
            }
            searchY--;
        }
        return null;
    },

    /**
     * Finds a safe location away from previous builds
     * @param {Vec3} startPos - Starting position to search from
     * @param {number} minDistance - Minimum distance from previous builds (default: 50 blocks)
     * @param {string} buildingType - Type of structure being built (for history tracking)
     * @returns {Promise<Vec3>} Safe location for building
     */
    async findSafeLocation(startPos, minDistance = 50, buildingType = 'structure') {
        const currentPos = bot.entity.position;
        const searchRadius = 150; // Search within 150 blocks (increased to accommodate 50 block minimum distance)
        const attempts = 20; // Try up to 20 different locations
        
        // Helper function to check if position is on surface (ground with air above)
        // CRITICAL: Checks that ground is a solid block (like grass_block), not a non-solid block (like grass)
        // Note: pos is the build position (above ground), so we check pos.y - 1 for the ground block
        const isSurfacePosition = (pos) => {
            const buildY = Math.floor(pos.y);
            const groundY = buildY - 1; // Ground block is one block below build position
            const groundBlock = bot.blockAt(new Vec3(Math.floor(pos.x), groundY, Math.floor(pos.z)));
            const airAtBuildPos = bot.blockAt(new Vec3(Math.floor(pos.x), buildY, Math.floor(pos.z)));
            
            // Check if ground block is solid (not grass, tall_grass, etc.)
            if (!groundBlock || groundBlock.type === 0 || groundBlock.name === 'air') {
                return false;
            }
            
            // Check if block is solid by boundingBox
            const isSolid = groundBlock.boundingBox === 'block' || 
                           (groundBlock.shapes && groundBlock.shapes.length > 0 && 
                            groundBlock.shapes.some(shape => shape === 'block'));
            
            // List of non-solid blocks to exclude
            const nonSolidBlocks = ['grass', 'tall_grass', 'fern', 'large_fern', 
                                   'dead_bush', 'dandelion', 'poppy', 'blue_orchid',
                                   'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
                                   'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
                                   'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac',
                                   'rose_bush', 'peony', 'sweet_berry_bush', 'wheat',
                                   'carrots', 'potatoes', 'beetroots', 'sugar_cane',
                                   'cactus', 'vine', 'ladder', 'torch', 'redstone_torch',
                                   'soul_torch', 'lantern', 'soul_lantern', 'campfire',
                                   'soul_campfire', 'fire', 'soul_fire'];
            
            const isNonSolidByName = nonSolidBlocks.includes(groundBlock.name);
            
            // Ground should be solid (not in non-solid list and has solid boundingBox), and build position should be air
            return isSolid && !isNonSolidByName &&
                   airAtBuildPos && (airAtBuildPos.type === 0 || airAtBuildPos.name === 'air');
        };
        
        // If no previous builds, use current position or nearby
        if (buildHistory.length === 0) {
            const groundPos = await this.findGround(currentPos);
            if (groundPos && isSurfacePosition(groundPos)) {
                return groundPos;
            }
            const startGroundPos = await this.findGround(startPos);
            if (startGroundPos && isSurfacePosition(startGroundPos)) {
                return startGroundPos;
            }
            // Return best available option
            return groundPos || startGroundPos || startPos;
        }
        
        // Try to find a location away from all previous builds
        for (let attempt = 0; attempt < attempts; attempt++) {
            // Generate random offset from current position
            const angle = Math.random() * Math.PI * 2;
            const distance = minDistance + Math.random() * (searchRadius - minDistance);
            const offsetX = Math.cos(angle) * distance;
            const offsetZ = Math.sin(angle) * distance;
            
            const candidateX = Math.floor(currentPos.x + offsetX);
            const candidateZ = Math.floor(currentPos.z + offsetZ);
            
            // Check if this location is far enough from all previous builds
            let isSafe = true;
            for (const prevBuild of buildHistory) {
                const dx = candidateX - prevBuild.x;
                const dz = candidateZ - prevBuild.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                
                if (dist < minDistance) {
                    isSafe = false;
                    break;
                }
            }
            
            if (isSafe) {
                // Find ground at this location
                const candidatePos = new Vec3(candidateX, currentPos.y, candidateZ);
                const groundPos = await this.findGround(candidatePos);
                
                if (groundPos) {
                    // Verify it's on surface (ground with air above)
                    const airAbove = bot.blockAt(new Vec3(Math.floor(groundPos.x), Math.floor(groundPos.y) + 1, Math.floor(groundPos.z)));
                    if (airAbove && (airAbove.type === 0 || airAbove.name === 'air')) {
                        console.log(`[SKILLS] Found safe surface location at (${Math.floor(groundPos.x)}, ${Math.floor(groundPos.y)}, ${Math.floor(groundPos.z)}) - ${minDistance.toFixed(1)} blocks from previous builds`);
                        return groundPos;
                    }
                }
            }
        }
        
        // Fallback: use a location further away
        console.log(`[SKILLS] Could not find ideal location, using fallback position`);
        const fallbackAngle = Math.random() * Math.PI * 2;
        const fallbackDistance = minDistance * 1.5;
        const fallbackX = currentPos.x + Math.cos(fallbackAngle) * fallbackDistance;
        const fallbackZ = currentPos.z + Math.sin(fallbackAngle) * fallbackDistance;
        const fallbackPos = new Vec3(fallbackX, currentPos.y, fallbackZ);
        const groundPos = await this.findGround(fallbackPos);
        
        // Ensure fallback is on surface (ground with air above)
        if (groundPos) {
            const airAbove = bot.blockAt(new Vec3(Math.floor(groundPos.x), Math.floor(groundPos.y) + 1, Math.floor(groundPos.z)));
            if (airAbove && (airAbove.type === 0 || airAbove.name === 'air')) {
                return groundPos;
            }
        }
        
        return groundPos || currentPos;
    },
    
    /**
     * Walk to a target location instead of teleporting
     * @param {Vec3} targetPos - Target position to walk to
     * @returns {Promise<boolean>} Success status
     */
    async walkToLocation(targetPos) {
        try {
            console.log(`[SKILLS] Walking to location (${Math.floor(targetPos.x)}, ${Math.floor(targetPos.y)}, ${Math.floor(targetPos.z)})`);
            // Silently walk - no chat messages
            
            // CRITICAL: Stop pathfinder completely before setting new goal
            // This prevents "goal was changed" errors
            try {
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
                await bot.waitForTicks(5); // Give pathfinder time to stop
            } catch (error) {
                console.warn(`[SKILLS] Error stopping pathfinder before walk: ${error.message}`);
            }
            
            // Ensure we're on the ground (not flying) for walking
            try {
                bot.chat('/gamemode survival'); // Switch to survival for walking
                await bot.waitForTicks(10);
            } catch (error) {
                console.warn(`[SKILLS] Could not switch to survival mode: ${error.message}`);
            }
            
            // Use pathfinder to walk to the location
            const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2); // Within 2 blocks is close enough
            
            // Use goto instead of setGoal to avoid conflicts
            try {
                await bot.pathfinder.goto(goal);
            } catch (error) {
                // If goto fails, try setGoal as fallback
                if (error.message && error.message.includes('goal was changed')) {
                    console.warn(`[SKILLS] Pathfinder goal conflict, retrying...`);
                    await bot.waitForTicks(10);
            bot.pathfinder.setGoal(goal);
                } else {
                    throw error;
                }
            }
            
            // Wait for pathfinder to complete (with timeout)
            const maxWaitTime = 30000; // 30 seconds max
            const startTime = Date.now();
            
            try {
            while (bot.pathfinder.isMoving() && (Date.now() - startTime) < maxWaitTime) {
                await bot.waitForTicks(5);
                }
            } catch (error) {
                // Ignore "goal was changed" errors during wait - they're expected when stopping
                if (!error.message || !error.message.includes('goal was changed')) {
                    throw error;
                }
            }
            
            // Check if we reached the goal
            const currentPos = bot.entity.position;
            const distance = currentPos.distanceTo(targetPos);
            
            if (distance <= 3) {
                console.log(`[SKILLS] Successfully walked to location (distance: ${distance.toFixed(1)} blocks)`);
                // Silently arrived - no chat message
                return true;
            } else {
                console.warn(`[SKILLS] Walk incomplete, distance: ${distance.toFixed(1)} blocks`);
                // Still return true if reasonably close
                return distance <= 10;
            }
        } catch (error) {
            console.error(`[SKILLS] Error walking to location: ${error.message}`);
            return false;
        }
    },

    /**
     * Records a build location in history
     * @param {Vec3} location - Build location
     * @param {string} buildingType - Type of structure built
     */
    recordBuildLocation(location, buildingType = 'structure') {
        buildHistory.push({
            x: Math.floor(location.x),
            y: Math.floor(location.y),
            z: Math.floor(location.z),
            type: buildingType,
            timestamp: Date.now()
        });
        console.log(`[SKILLS] Recorded build: ${buildingType} at (${Math.floor(location.x)}, ${Math.floor(location.y)}, ${Math.floor(location.z)})`);
        console.log(`[SKILLS] Total builds in session: ${buildHistory.length}`);
    },

    /**
     * Generates a blueprint using LLM based on user description
     */
    /**
     * Main blueprint generation function with hybrid approach
     * Automatically selects best method (Code Generation or JSON) based on request type
     */
    async generateBlueprint(description, clarificationAnswers = {}) {
        try {
            console.log(`[SKILLS] Generating blueprint: "${description}"`);
            
            // Combine description with clarification answers
            let fullDescription = description;
            if (Object.keys(clarificationAnswers).length > 0) {
                const answersText = Object.entries(clarificationAnswers)
                    .map(([q, a]) => `${q}: ${a}`)
                    .join(', ');
                fullDescription = `${description}. Additional details: ${answersText}`;
            }
            
            // Step 1: Analyze request type to choose generation method
            const requestType = this.analyzeRequestType(fullDescription);
            console.log(`[SKILLS] Request type: ${requestType.reason}, using ${requestType.useCodeGeneration ? 'Code Generation' : 'JSON mode'}`);
            
            // Step 2: Try primary method
            let blueprint;
            try {
                if (requestType.useCodeGeneration) {
                    blueprint = await this.generateBlueprintWithCode(fullDescription);
                } else {
                    blueprint = await this.generateBlueprintWithJSON(fullDescription);
                }
                
                // Step 3: Validate quality
                if (this.validateBlueprintQuality(blueprint, fullDescription)) {
                    console.log(`[SKILLS] Blueprint generated successfully with ${blueprint.length} blocks`);
                    return blueprint;
                } else {
                    throw new Error('Blueprint quality validation failed');
                }
            } catch (primaryError) {
                // Step 4: Fallback to alternative method
                console.warn(`[SKILLS] Primary method failed (${requestType.useCodeGeneration ? 'Code Generation' : 'JSON mode'}), trying fallback: ${primaryError.message}`);
                try {
                    if (requestType.useCodeGeneration) {
                        blueprint = await this.generateBlueprintWithJSON(fullDescription);
                    } else {
                        blueprint = await this.generateBlueprintWithCode(fullDescription);
                    }
                    
                    if (this.validateBlueprintQuality(blueprint, fullDescription)) {
                        console.log(`[SKILLS] Fallback method succeeded with ${blueprint.length} blocks`);
                        return blueprint;
                    } else {
                        throw new Error('Fallback blueprint quality validation failed');
                    }
                } catch (fallbackError) {
                    throw new Error(`Both generation methods failed. Primary: ${primaryError.message}, Fallback: ${fallbackError.message}`);
                }
            }
        } catch (error) {
            console.error(`[SKILLS] Error generating blueprint: ${error.message}`);
            throw error;
        }
    },

    /**
     * Analyze request type to determine best generation method
     */
    analyzeRequestType(description) {
        const descLower = description.toLowerCase();
        
        // Keywords that favor Code Generation (geometric/mathematical shapes)
        const codeGenerationKeywords = [
            'box', 'cube', 'cylinder', 'sphere', 'ball', 'circle',
            'spiral', 'candy cane', 'cane', 'star', 'triangle',
            'square', 'rectangle', 'pyramid', 'cone', 'gift', 'present',
            'tree', 'wreath', 'ornament'
        ];
        
        // Keywords that favor JSON mode (abstract/artistic concepts)
        const jsonModeKeywords = [
            'cute', 'adorable', 'beautiful', 'elegant', 'fancy',
            'decorated', 'ornate', 'detailed', 'intricate',
            'pony', 'animal', 'character', 'face', 'smile', 'happy'
        ];
        
        const hasCodeKeywords = codeGenerationKeywords.some(kw => descLower.includes(kw));
        const hasJsonKeywords = jsonModeKeywords.some(kw => descLower.includes(kw));
        
        // Decision logic
        if (hasCodeKeywords && !hasJsonKeywords) {
            return { useCodeGeneration: true, reason: 'geometric_shape' };
        } else if (hasJsonKeywords && !hasCodeKeywords) {
            return { useCodeGeneration: false, reason: 'artistic_shape' };
        } else if (hasCodeKeywords && hasJsonKeywords) {
            // Both present: prefer Code Generation but allow fallback
            return { useCodeGeneration: true, reason: 'geometric_with_artistic_elements' };
        } else {
            // Default: try Code Generation first (better for most shapes)
            return { useCodeGeneration: true, reason: 'default_try_code' };
        }
    },

    /**
     * Generate blueprint using Code Generation method
     */
    async generateBlueprintWithCode(description) {
        try {
            console.log(`[SKILLS] Using Code Generation method`);
            
            const completion = await callOpenAIWithRetry(() =>
                openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content: BLUEPRINT_GENERATION_PROMPT_CODE
                        },
                        {
                            role: 'user',
                            content: `Generate JavaScript code to create a Christmas-themed Minecraft structure: ${description}`
                        }
                    ],
                    temperature: 0.7
                    // Note: No response_format constraint - we want code, not JSON
                })
            );
            
            trackAPIUsage(completion.usage);
            
            const responseContent = completion.choices[0].message.content;
            
            // Extract JavaScript code from markdown code blocks
            const codeMatch = responseContent.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
            if (!codeMatch) {
                // Fallback: try direct execution if no code blocks
                console.warn('[SKILLS] No code block found, trying direct execution');
                const codeString = responseContent.trim();
                return await this.executeBlueprintCode(codeString, description);
            }
            
            const codeString = codeMatch[1].trim();
            return await this.executeBlueprintCode(codeString, description);
            
        } catch (error) {
            console.error(`[SKILLS] Code Generation failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Generate blueprint using JSON method (original method)
     */
    async generateBlueprintWithJSON(description) {
        try {
            console.log(`[SKILLS] Using JSON mode`);
            
            const completion = await callOpenAIWithRetry(() =>
                openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content: BLUEPRINT_GENERATION_PROMPT
                        },
                        {
                            role: 'user',
                            content: `Generate a Christmas-themed Minecraft blueprint: ${description}`
                        }
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.7
                })
            );
            
            trackAPIUsage(completion.usage);
            
            const responseContent = completion.choices[0].message.content;
            const blueprintData = JSON.parse(responseContent);
            
            if (!blueprintData.blocks || !Array.isArray(blueprintData.blocks)) {
                throw new Error('Invalid blueprint format from LLM');
            }
            
            // Convert to Vec3 format
            const blueprint = blueprintData.blocks.map(entry => ({
                block: entry.block,
                pos: new Vec3(entry.pos.x, entry.pos.y, entry.pos.z)
            }));
            
            // Save to file
            this.saveBlueprintToFile(blueprint, description);
            
            console.log(`[SKILLS] Generated blueprint with ${blueprint.length} blocks (JSON mode)`);
            return blueprint;
        } catch (error) {
            console.error(`[SKILLS] JSON generation failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Safely execute blueprint generation code
     */
    async executeBlueprintCode(codeString, description) {
        // Security: Check for dangerous patterns
        const dangerous = ['require', 'import', 'eval', 'Function', 'process', 'global', '__dirname', '__filename', 'fs', 'path', 'child_process'];
        for (const pattern of dangerous) {
            if (codeString.includes(pattern)) {
                throw new Error(`Dangerous pattern detected: ${pattern}`);
            }
        }
        
        // Create safe execution context
        const safeContext = {
            Math: Math,
            Array: Array,
            Object: Object,
            String: String,
            Number: Number,
            Boolean: Boolean,
            console: { 
                log: (...args) => console.log('[BLUEPRINT CODE]', ...args),
                warn: (...args) => console.warn('[BLUEPRINT CODE]', ...args),
                error: (...args) => console.error('[BLUEPRINT CODE]', ...args)
            }
        };
        
        try {
            // Execute code in safe context
            const func = new Function(...Object.keys(safeContext), codeString);
            const result = func(...Object.values(safeContext));
            
            // Check return value - handle multiple possible formats
            let blocksArray;
            if (typeof result === 'function') {
                // If returns a function, call it
                blocksArray = result({x: 0, y: 0, z: 0}, {});
            } else if (Array.isArray(result)) {
                // If directly returns array
                blocksArray = result;
            } else if (result && typeof result === 'object') {
                // If returns an object with blocks property
                if (Array.isArray(result.blocks)) {
                    blocksArray = result.blocks;
                } else if (result.blueprint && Array.isArray(result.blueprint)) {
                    blocksArray = result.blueprint;
                    } else {
                        // Try to extract blocks from object values
                        const values = Object.values(result);
                        const arrayValue = values.find(v => Array.isArray(v));
                        if (arrayValue) {
                            blocksArray = arrayValue;
                        } else {
                            const resultStr = result ? JSON.stringify(result).substring(0, 200) : 'undefined';
                            throw new Error(`Generated code returned object but no blocks array found. Returned: ${resultStr}`);
                        }
                    }
                } else {
                    // Try to find generateBlueprint function in the code context
                    if (safeContext.generateBlueprint && typeof safeContext.generateBlueprint === 'function') {
                        blocksArray = safeContext.generateBlueprint({x: 0, y: 0, z: 0}, {});
                    } else {
                        const resultStr = result !== undefined && result !== null ? JSON.stringify(result).substring(0, 200) : String(result);
                        throw new Error(`Generated code did not return a function, array, or object with blocks. Returned type: ${typeof result}, value: ${resultStr}`);
                    }
                }
            
            // Validate blocksArray
            if (!Array.isArray(blocksArray)) {
                throw new Error(`Expected array but got ${typeof blocksArray}`);
            }
            
            if (blocksArray.length === 0) {
                throw new Error('Generated blueprint is empty');
            }
            
            // Convert to blueprint format
            return this.convertToBlueprint(blocksArray, description);
            
        } catch (error) {
            console.error(`[SKILLS] Code execution error: ${error.message}`);
            throw new Error(`Code execution failed: ${error.message}`);
        }
    },

    /**
     * Convert blocks array to blueprint format
     */
    convertToBlueprint(blocksArray, description) {
        if (!Array.isArray(blocksArray)) {
            throw new Error('Generated function did not return an array');
        }
        
        if (blocksArray.length === 0) {
            throw new Error('Generated blueprint is empty');
        }
        
        if (blocksArray.length > 5000) {
            throw new Error('Generated blueprint is too large (max 5000 blocks)');
        }
        
        // Convert to Vec3 format (support multiple input formats)
        const blueprint = blocksArray.map(entry => {
            const block = entry.block || entry.type || 'stone';
            const pos = entry.pos || {x: entry.x || 0, y: entry.y || 0, z: entry.z || 0};
            
            return {
                block: block,
                pos: new Vec3(pos.x, pos.y, pos.z)
            };
        });
        
        // Save to file
        this.saveBlueprintToFile(blueprint, description);
        
        return blueprint;
    },

    /**
     * Validate blueprint quality
     */
    validateBlueprintQuality(blueprint, description) {
        // Check basic requirements
        if (!blueprint || blueprint.length === 0) {
            console.warn('[SKILLS] Blueprint is empty');
            return false;
        }
        
        if (blueprint.length > 5000) {
            console.warn('[SKILLS] Blueprint too large');
            return false;
        }
        
        // Check for duplicate positions (shouldn't have too many)
        // Allow up to 15% duplicates (some structures legitimately have overlapping blocks)
        const uniquePositions = new Set(blueprint.map(b => `${b.pos.x},${b.pos.y},${b.pos.z}`));
        const duplicateRatio = 1 - (uniquePositions.size / blueprint.length);
        if (duplicateRatio > 0.15) {
            console.warn(`[SKILLS] Too many duplicate positions: ${(duplicateRatio * 100).toFixed(1)}%`);
            return false;
        }
        
        // If duplicates are between 10-15%, log but allow (might be intentional)
        if (duplicateRatio > 0.1 && duplicateRatio <= 0.15) {
            console.log(`[SKILLS] Some duplicate positions detected: ${(duplicateRatio * 100).toFixed(1)}% (within acceptable range)`);
        }
        
        // Check dimensions are reasonable
        const xs = blueprint.map(b => b.pos.x);
        const ys = blueprint.map(b => b.pos.y);
        const zs = blueprint.map(b => b.pos.z);
        const maxDim = Math.max(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
            Math.max(...zs) - Math.min(...zs)
        );
        
        if (maxDim > 20) {
            console.warn(`[SKILLS] Structure too large: ${maxDim} blocks`);
            return false;
        }
        
        // Check all blocks have valid names
        const invalidBlocks = blueprint.filter(b => !b.block || typeof b.block !== 'string');
        if (invalidBlocks.length > 0) {
            console.warn(`[SKILLS] ${invalidBlocks.length} blocks have invalid names`);
            return false;
        }
        
        return true;
    },

    /**
     * Saves blueprint to llm-blueprint-output.txt
     */
    saveBlueprintToFile(blueprint, description = '') {
        try {
            const outputPath = path.join(__dirname, 'llm-blueprint-output.txt');
            let content = `// LLM-Generated Blueprint\n`;
            content += `// Generated: ${new Date().toISOString()}\n`;
            if (description) {
                content += `// Description: ${description}\n`;
            }
            if (!Array.isArray(blueprint)) {
                throw new Error('Blueprint must be an array');
            }
            
            content += `// Total blocks: ${blueprint.length}\n\n`;
            content += `const blueprint = [\n`;
            
            blueprint.forEach((entry, i) => {
                if (!entry || !entry.block || !entry.pos) {
                    console.warn(`[SKILLS] Skipping invalid blueprint entry at index ${i}`);
                    return;
                }
                const comma = i < blueprint.length - 1 ? ',' : '';
                content += `    { block: '${entry.block}', pos: new Vec3(${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}) }${comma}\n`;
            });
            
            content += `];\n`;
            
            fs.writeFileSync(outputPath, content, 'utf-8');
            console.log(`[SKILLS] Blueprint saved to ${outputPath}`);
            return outputPath;
        } catch (error) {
            console.error(`[SKILLS] Error saving blueprint: ${error.message}`);
            return null;
        }
    },

    /**
     * Loads blueprint from file
     */
    async loadBlueprint(blueprintPath = null) {
        try {
            const filePath = blueprintPath || 'llm-blueprint-output.txt';
            const fullPath = path.join(__dirname, filePath);
            
            if (!fs.existsSync(fullPath)) {
                console.warn(`[SKILLS] Blueprint file not found: ${fullPath}`);
                return null;
            }
            
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            
            // Try to parse as JavaScript code format
            const blueprintMatch = fileContent.match(/const\s+blueprint\s*=\s*\[([\s\S]*?)\];/);
            if (blueprintMatch) {
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
                    console.log(`[SKILLS] Loaded blueprint from ${filePath}: ${entries.length} blocks`);
                    return entries;
                }
            }
            
            return null;
        } catch (error) {
            console.error(`[SKILLS] Error loading blueprint: ${error.message}`);
            return null;
        }
    },

    /**
     * Builds structure from blueprint
     */
    async buildStructure(origin, customBlueprint = null, buildingType = 'structure') {
        try {
            const baseX = Math.floor(origin.x);
            const baseY = Math.floor(origin.y);
            const baseZ = Math.floor(origin.z);
            const centre = new Vec3(baseX, baseY, baseZ);
            
            console.log(`[SKILLS] Building ${buildingType} at (${baseX}, ${baseY}, ${baseZ})`);
            
            // Record build location in history
            this.recordBuildLocation(centre, buildingType);
            
            // Lock behavior system
            const wasBehaviorEnabled = BEHAVIOUR_CONFIG.enabled;
            BEHAVIOUR_CONFIG.enabled = false;
            behaviourState.isExecutingTask = true;
            behaviourState.workCenter = centre;
            
            // Stop behavior system FIRST and wait a bit to ensure all async operations complete
            stopNaturalBehavior();
            await bot.waitForTicks(10); // Give time for any pending pathfinder operations to complete
            
            // Walk to the build location instead of teleporting
            const walkSuccess = await this.walkToLocation(centre);
            if (!walkSuccess) {
                console.warn(`[SKILLS] Could not walk to location, but continuing anyway`);
            }
            
            // Stop pathfinder after walking (ensure it's stopped)
            try {
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
                await bot.waitForTicks(5); // Give pathfinder time to fully stop
            } catch (error) {
                // Ignore "goal was changed" errors - they're expected when stopping
                if (!error.message || !error.message.includes('goal was changed')) {
                console.warn('[SKILLS] Error stopping pathfinder:', error.message);
                }
            }
            
            // Disable following
            behaviourState.isFollowing = false;
            behaviourState.followingPlayer = null;
            
            // Set game mode and enable flight (for building)
            try {
                bot.chat('/gamemode creative');
                await new Promise(resolve => setTimeout(resolve, 500));
                bot.chat('/fly');
                bot.chat('/ability @s mayfly true');
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.warn('[SKILLS] Error setting game mode:', error.message);
            }
            
            // Load blueprint
            let blueprint = customBlueprint;
            if (!blueprint) {
                blueprint = await this.loadBlueprint('llm-blueprint-output.txt');
            }
            
            if (!blueprint || blueprint.length === 0) {
                throw new Error('No blueprint available to build');
            }
            
            // Position maintenance setup
            let lastTeleportPos = bot.entity.position.clone();
            let expectedY = baseY + 10;
            let flightMaintenanceInterval = null;
            
            const maintainPosition = async () => {
                if (!behaviourState.isExecutingTask) return;
                const currentPos = bot.entity.position;
                const targetY = expectedY;
                
                if (Math.abs(currentPos.y - targetY) > 0.5) {
                    try {
                        bot.chat(`/tp ${bot.username} ${Math.floor(lastTeleportPos.x)} ${Math.floor(targetY)} ${Math.floor(lastTeleportPos.z)}`);
                        await new Promise(resolve => setTimeout(resolve, 10));
                    } catch (e) {}
                }
                
                if (currentPos.distanceTo(lastTeleportPos) > 1) {
                    try {
                        bot.chat(`/tp ${bot.username} ${Math.floor(lastTeleportPos.x)} ${Math.floor(currentPos.y)} ${Math.floor(lastTeleportPos.z)}`);
                        await new Promise(resolve => setTimeout(resolve, 10));
                    } catch (e) {}
                }
            };
            
            flightMaintenanceInterval = setInterval(() => {
                if (behaviourState.isExecutingTask) {
                    maintainPosition().catch(() => {});
                }
            }, 5);
            
            // Side directions for teleportation (horizontal only)
            const sideDirections = [
                new Vec3(1, 0, 0),   // East
                new Vec3(-1, 0, 0),  // West
                new Vec3(0, 0, 1),   // South
                new Vec3(0, 0, -1)   // North
            ];
            
            let failCount = 0;
            const totalBlocks = blueprint.length;
            
            // Sort blueprint by Y (height) first, then by X, then by Z for layer-by-layer building
            // This ensures we build horizontally layer by layer (from bottom to top)
            const sortedBlueprint = [...blueprint].sort((a, b) => {
                const aY = a.pos.y;
                const bY = b.pos.y;
                if (aY !== bY) {
                    return aY - bY; // Lower Y first (bottom to top)
                }
                // Within same layer, sort by X then Z for consistent order
                const aX = a.pos.x;
                const bX = b.pos.x;
                if (aX !== bX) {
                    return aX - bX;
                }
                return a.pos.z - b.pos.z;
            });
            
            console.log(`[SKILLS] Building ${totalBlocks} blocks layer by layer (horizontal layers from bottom to top)`);
            
            // Execute blueprint layer by layer
            let currentLayer = null;
            let layerCount = 0;
            for (let i = 0; i < sortedBlueprint.length; i++) {
                const entry = sortedBlueprint[i];
                const relativePos = entry.pos;
                const absoluteX = baseX + relativePos.x;
                const absoluteY = baseY + relativePos.y;
                const absoluteZ = baseZ + relativePos.z;
                
                // Track layer changes
                if (currentLayer === null || currentLayer !== relativePos.y) {
                    currentLayer = relativePos.y;
                    layerCount++;
                    console.log(`[SKILLS] Building layer ${layerCount} at Y=${currentLayer} (${sortedBlueprint.filter(e => e.pos.y === currentLayer).length} blocks)`);
                }
                
                const targetPos = new Vec3(absoluteX, absoluteY, absoluteZ);
                const targetLookPos = new Vec3(absoluteX, absoluteY, absoluteZ);
                
                // Find suitable teleport position (side of air block)
                let teleportPos = null;
                for (const sideOffset of sideDirections) {
                    const checkPos = targetPos.plus(sideOffset);
                    const checkBlock = bot.blockAt(checkPos);
                    
                    if (checkBlock && checkBlock.name === 'air') {
                        teleportPos = new Vec3(
                            checkPos.x,
                            absoluteY + 1,
                            checkPos.z
                        );
                        break;
                    }
                }
                
                if (!teleportPos) {
                    // Fallback: use first side direction
                    const fallbackOffset = sideDirections[0];
                    teleportPos = new Vec3(
                        targetPos.x + fallbackOffset.x,
                        absoluteY + 1,
                        targetPos.z + fallbackOffset.z
                    );
                }
                
                // Ultra Fast Mode: Skip teleportation and lookAt for most blocks
                // Only teleport when moving to a new layer or when distance is significant
                const needsTeleport = currentLayer === null || 
                                     currentLayer !== relativePos.y || 
                                     !lastTeleportPos || 
                                     lastTeleportPos.distanceTo(teleportPos) > 5;
                
                if (needsTeleport) {
                try {
                    bot.chat(`/tp ${bot.username} ${Math.floor(teleportPos.x)} ${Math.floor(teleportPos.y)} ${Math.floor(teleportPos.z)}`);
                        // Ultra Fast Mode: Minimal delay for teleportation
                        await new Promise(resolve => setTimeout(resolve, 10));
                    bot.lookAt(targetLookPos, true);
                        // No delay after lookAt - immediate block placement
                    
                    lastTeleportPos = teleportPos.clone();
                    expectedY = teleportPos.y;
                } catch (error) {
                    console.warn(`[SKILLS] Teleport failed: ${error.message}`);
                    }
                }
                
                // Place block using /setblock
                try {
                    // Ensure block name is valid
                    if (!entry.block || typeof entry.block !== 'string') {
                        console.warn(`[SKILLS] Invalid block name at index ${i}: ${JSON.stringify(entry)}`);
                        continue;
                    }
                    const blockName = entry.block.startsWith('minecraft:') ? entry.block : `minecraft:${entry.block}`;
                    
                    // Debug: Log first few blocks of each layer to verify colors
                    const blocksInLayer = sortedBlueprint.filter(e => e.pos.y === relativePos.y);
                    const blockIndexInLayer = blocksInLayer.findIndex(e => e === entry);
                    if (blockIndexInLayer < 3 || i < 5) {
                        console.log(`[SKILLS] Placing block ${i + 1}/${totalBlocks} (layer ${layerCount}, block ${blockIndexInLayer + 1}/${blocksInLayer.length}): ${blockName} at (${absoluteX}, ${absoluteY}, ${absoluteZ})`);
                        // Check if entry has debug RGB info (from process3DModel)
                        if (entry._debug_rgb) {
                            console.log(`[SKILLS]   RGB: (${entry._debug_rgb.r}, ${entry._debug_rgb.g}, ${entry._debug_rgb.b}) → Block: ${blockName}`);
                        }
                    }
                    
                    bot.chat(`/setblock ${absoluteX} ${absoluteY} ${absoluteZ} ${blockName} replace`);
                    // Ultra Fast Mode: 70x speed boost - batch placement with minimal delays
                    // Wait only every 200 blocks to allow server to process commands
                    // For 10000 blocks: ~50 waits total instead of 10000 waits
                    if (i % 200 === 0 && i > 0) {
                        await bot.waitForTicks(1);
                    }
                    // For very large models, add a tiny async delay every 50 blocks to prevent command queue overflow
                    else if (totalBlocks > 5000 && i % 50 === 0 && i > 0) {
                        // Use setImmediate for non-blocking async delay (faster than waitForTicks)
                        await new Promise(resolve => setImmediate(resolve));
                    }
                } catch (error) {
                    console.warn(`[SKILLS] Failed to place block at (${absoluteX}, ${absoluteY}, ${absoluteZ}): ${error.message}`);
                    failCount++;
                }
                
                // Progress update every 50 blocks or at layer completion
                const isLastBlockInLayer = i === sortedBlueprint.length - 1 || sortedBlueprint[i + 1].pos.y !== relativePos.y;
                if ((i + 1) % 50 === 0 || isLastBlockInLayer) {
                    const progress = Math.floor(((i + 1) / totalBlocks) * 100);
                    if (isLastBlockInLayer) {
                        console.log(`[SKILLS] ✓ Completed layer ${layerCount} (Y=${relativePos.y}) - Progress: ${i + 1}/${totalBlocks} blocks (${progress}%)`);
                    } else {
                        console.log(`[SKILLS] Progress: ${i + 1}/${totalBlocks} blocks (${progress}%)`);
                    }
                }
            }
            
            // Cleanup
            if (flightMaintenanceInterval) {
                clearInterval(flightMaintenanceInterval);
                flightMaintenanceInterval = null;
            }
            
            behaviourState.isExecutingTask = false;
            BEHAVIOUR_CONFIG.enabled = wasBehaviorEnabled;
            if (wasBehaviorEnabled) {
                startNaturalBehavior();
            }
            
            if (failCount > 0) {
                bot.chat(`Finished building! (${failCount} blocks had issues)`);
            } else {
                bot.chat(getRandomResponse('success'));
            }
            
            // Celebrate after building completion!
            await this.celebrateBuildCompletion();
            
            return { success: true, blocksPlaced: totalBlocks - failCount, totalBlocks, failCount };
        } catch (error) {
            behaviourState.isExecutingTask = false;
            BEHAVIOUR_CONFIG.enabled = true;
            startNaturalBehavior();
            console.error(`[SKILLS] Error in buildStructure: ${error.message}`);
            bot.chat(getRandomResponse('error'));
            throw error;
        }
    },

    /**
     * Nod gesture
     */
    async nod() {
        return { success: true };
    },

    /**
     * Celebrate with fireworks
     */
    /**
     * Celebrate after building completion with exciting movements
     * Quickly performs multiple celebration actions within 2 seconds (no chat messages)
     */
    async celebrateBuildCompletion() {
        // Randomly choose celebration style
        const celebrationStyle = Math.random() < 0.5 ? 'squat' : 'dance';
        
        if (celebrationStyle === 'squat') {
            // Do 5 quick squats (crouch and jump) - faster timing for 2s completion
            for (let i = 0; i < 5; i++) {
                // Crouch (sneak)
                bot.setControlState('sneak', true);
                await bot.waitForTicks(3); // Faster: 3 ticks instead of 10
                // Jump
                bot.setControlState('sneak', false);
                bot.setControlState('jump', true);
                await bot.waitForTicks(2); // Faster: 2 ticks instead of 5
                bot.setControlState('jump', false);
                await bot.waitForTicks(3); // Faster: 3 ticks instead of 10
            }
        } else {
            // Dance/swing hands (look around and jump) - faster timing
            const currentYaw = bot.entity.yaw;
            for (let i = 0; i < 5; i++) {
                // Look left
                bot.look(currentYaw - Math.PI / 2, bot.entity.pitch, true);
                await bot.waitForTicks(2); // Faster: 2 ticks instead of 5
                // Jump
                bot.setControlState('jump', true);
                await bot.waitForTicks(2);
                bot.setControlState('jump', false);
                // Look right
                bot.look(currentYaw + Math.PI / 2, bot.entity.pitch, true);
                await bot.waitForTicks(2);
                // Jump again
                bot.setControlState('jump', true);
                await bot.waitForTicks(2);
                bot.setControlState('jump', false);
                // Return to center
                bot.look(currentYaw, bot.entity.pitch, true);
                await bot.waitForTicks(3); // Faster: 3 ticks instead of 10
            }
        }
        
        // Silently check if player is nearby (no chat message)
        const nearestPlayer = findNearestPlayer();
        if (nearestPlayer) {
            const distance = bot.entity.position.distanceTo(nearestPlayer.position);
            if (distance < 10) {
                // Player is nearby - they probably noticed, but don't say anything
                // Just do one more quick jump to catch attention
                bot.setControlState('jump', true);
                await bot.waitForTicks(2);
                bot.setControlState('jump', false);
            }
        }
    },

    /**
     * Celebrate with beautiful, colourful fireworks using firework stars
     * Uses specific firework recipe: Flight Duration 1, Small Ball (Light Blue, Red, Blue, White with Trail),
     * Large Ball (Yellow, Red, Green, White)
     */
    async celebrate() {
        const pos = bot.entity.position;
        
        // Specific firework recipe from user's request:
        // Flight Duration: 1
        // Small Ball: Light Blue, Red, Blue, White (with Trail)
        // Large Ball: Yellow, Red, Green, White
        // Color values: Light Blue=56575, Red=16711680, Blue=255, White=16777215, Yellow=16776960, Green=65280
        
        // Specific firework NBT data
        const fireworkNBT = '{Fireworks:{Flight:1,Explosions:[{Type:0,Colors:[I;56575,16711680,255,16777215],Trail:1b},{Type:1,Colors:[I;16776960,16711680,65280,16777215]}]}}';
        
        // Method 1: Use /summon (MOST RELIABLE - spawns already-launched fireworks, no need to activate)
        // This is preferred because it doesn't require activating items
        try {
            console.log('[SKILLS] Launching fireworks using /summon method...');
            for (let i = 0; i < 5; i++) {
                const offsetX = (Math.random() - 0.5) * 3;
                const offsetZ = (Math.random() - 0.5) * 3;
                const offsetY = Math.random() * 2;
                // Summon firework rocket with NBT data (already launched)
                bot.chat(`/summon firework_rocket ${pos.x + offsetX} ${pos.y + 2 + offsetY} ${pos.z + offsetZ} ${fireworkNBT}`);
                await bot.waitForTicks(5);
            }
            bot.chat('✨ Beautiful fireworks!');
            return { success: true };
        } catch (error) {
            console.warn(`[SKILLS] /summon method failed: ${error.message}, trying /give method`);
        }
        
        // Method 2: Use /give with NBT, then activate item (requires item activation)
        // Try /give with NBT in quotes (some servers require this)
        try {
            // Give bot firework rockets with specific NBT (try with quotes)
            const fireworkNBTQuoted = `"${fireworkNBT}"`;
            bot.chat(`/give @s firework_rocket 5 ${fireworkNBTQuoted}`);
            await bot.waitForTicks(20); // Wait for items to be given
            
            // Find firework rocket in inventory
            const firework = bot.inventory.items().find(item => item.name === 'firework_rocket');
            
            if (firework) {
                // Equip firework rocket to hand
                await bot.equip(firework, 'hand');
                await bot.waitForTicks(10);
                
                // Look up at the sky before activating (fireworks need to be launched upward)
                bot.look(0, -Math.PI / 2, true); // Look straight up
                await bot.waitForTicks(5);
                
                // Launch fireworks by activating the item (right-click in air)
                // Ensure firework is in main hand before activating
                const currentItem = bot.inventory.slots[36 + bot.quickBarSlot]; // Main hand slot
                if (!currentItem || currentItem.name !== 'firework_rocket') {
                    // Re-equip if not in hand
                    await bot.equip(firework, 'hand');
                    await bot.waitForTicks(5);
                }
                
                for (let i = 0; i < 5; i++) {
                    // Try multiple activation methods
                    try {
                        // Method A: activateItem (standard mineflayer API for right-click)
                        bot.activateItem();
                    } catch (e1) {
                        try {
                            // Method B: useItem (if available)
                            if (typeof bot.useItem === 'function') {
                                await bot.useItem(bot.heldItem);
                            }
                        } catch (e2) {
                            try {
                                // Method C: Send use_item packet directly
                                if (bot._client && bot._client.write) {
                                    bot._client.write('use_item', { hand: 0 });
                                }
                            } catch (e3) {
                                console.warn(`[SKILLS] All activation methods failed for firework ${i + 1}`);
                            }
                        }
                    }
                    await bot.waitForTicks(20); // Wait between launches for visual effect
                }
                bot.chat('✨ Beautiful fireworks!');
                return { success: true };
            }
        } catch (error) {
            console.warn(`[SKILLS] Method 1 failed: ${error.message}`);
        }
        
        // Method 2: Try /give without quotes
        try {
            bot.chat(`/give @s firework_rocket 5 ${fireworkNBT}`);
            await bot.waitForTicks(20);
            
            const firework = bot.inventory.items().find(item => item.name === 'firework_rocket');
            if (firework) {
                await bot.equip(firework, 'hand');
                await bot.waitForTicks(10);
                
                // Look up at the sky before activating
                bot.look(0, -Math.PI / 2, true); // Look straight up
                await bot.waitForTicks(5);
                
                // Ensure firework is in main hand before activating
                const currentItem = bot.inventory.slots[36 + bot.quickBarSlot];
                if (!currentItem || currentItem.name !== 'firework_rocket') {
                    await bot.equip(firework, 'hand');
                    await bot.waitForTicks(5);
                }
                
                for (let i = 0; i < 5; i++) {
                    // Try multiple activation methods
                    try {
                        bot.activateItem();
                    } catch (e1) {
                        try {
                            if (typeof bot.useItem === 'function') {
                                await bot.useItem(bot.heldItem);
                            }
                        } catch (e2) {
                            try {
                                if (bot._client && bot._client.write) {
                                    bot._client.write('use_item', { hand: 0 });
                                }
                            } catch (e3) {
                                console.warn(`[SKILLS] All activation methods failed for firework ${i + 1}`);
                            }
                        }
                    }
                    await bot.waitForTicks(20);
                }
                bot.chat('✨ Beautiful fireworks!');
                return { success: true };
            }
        } catch (error) {
            console.warn(`[SKILLS] Method 2 failed: ${error.message}`);
        }
        
        // Method 3: Final fallback - simple summon without NBT (default firework)
        console.warn(`[SKILLS] All methods failed, using default fireworks`);
        for (let i = 0; i < 5; i++) {
            const offsetX = (Math.random() - 0.5) * 3;
            const offsetZ = (Math.random() - 0.5) * 3;
            const offsetY = Math.random() * 2;
            bot.chat(`/summon firework_rocket ${pos.x + offsetX} ${pos.y + 2 + offsetY} ${pos.z + offsetZ}`);
            await bot.waitForTicks(5);
        }
        
        bot.chat('✨ Beautiful fireworks!');
        return { success: true };
    },

    /**
     * Generate color scheme using AI based on prompt
     * @param {string} prompt - Original prompt describing the model
     * @param {Array} blueprintData - Current blueprint data with positions
     * @returns {Promise<Object>} Color mapping rules
     */
    async generateAIColorScheme(prompt, blueprintData) {
        try {
            console.log(`[SKILLS] 🤖 AI Coloring: Generating color scheme for "${prompt}"...`);
            bot.chat(`🎨 The model doesn't have colors, so I'm using AI to add beautiful colors based on what it should look like!`);
            
            // Analyze model structure (bounds, shape hints)
            const bounds = {
                minX: Math.min(...blueprintData.map(e => e.x)),
                maxX: Math.max(...blueprintData.map(e => e.x)),
                minY: Math.min(...blueprintData.map(e => e.y)),
                maxY: Math.max(...blueprintData.map(e => e.y)),
                minZ: Math.min(...blueprintData.map(e => e.z)),
                maxZ: Math.max(...blueprintData.map(e => e.z))
            };
            const width = bounds.maxX - bounds.minX + 1;
            const height = bounds.maxY - bounds.minY + 1;
            const depth = bounds.maxZ - bounds.minZ + 1;
            
            const colorPrompt = `You are a color expert for Minecraft builds. Based on this description: "${prompt}"

The model has these dimensions: width=${width}, height=${height}, depth=${depth} blocks.

CRITICAL SKIN COLOR RULE:
- For ANY human skin, character skin, face, hands, or body parts: ALWAYS use white_terracotta (PRIORITY #1) or smooth_sandstone (PRIORITY #2)
- NEVER use yellow_wool for skin colors - it is not suitable for skin rendering
- Pink blocks (pink_wool, pink_concrete) are allowed for skin colors if appropriate
- Skin colors should be rendered as white_terracotta (most fit and suitable) or smooth_sandstone
- This ensures clean, appropriate skin rendering in Minecraft

Generate a color scheme as JSON with this structure:
{
  "color_rules": [
    {
      "condition": "description of where to apply (e.g., 'top half', 'left side', 'stripes', 'base', 'center', 'spiral', 'vertical stripes', 'horizontal bands', 'trunk', 'leaves', 'crown', 'foliage', 'branch')",
      "rgb": [r, g, b],
      "block": "minecraft_block_name",
      "block_variants": ["alternative_block_1", "alternative_block_2"]
    }
  ],
  "pattern": "description of the color pattern (e.g., 'red and white stripes', 'green base with red top', 'green leaves with brown trunk')",
  "shape_hints": ["cylindrical", "spiral", "layered", "boxy", "organic", "tree-like", "tapering"] (optional, helps with color application)
}

IMPORTANT STRUCTURE-AWARE COLORING:
- For TREE structures: Use "trunk" or "stem" for bottom narrow part, "leaves" or "crown" or "foliage" for top wider part
- For CANDY CANE: Use "spiral" condition for alternating red/white pattern
- For LAYERED structures: Use "layer" or "band" conditions
- The system can automatically detect tree-like structures (tapering upward, wider at bottom), so use specific terms like "trunk" and "leaves"

CRITICAL COLOR LIMIT REQUIREMENT:
- Use MAXIMUM 4 distinct colors (4 color_rules maximum)
- Each color can have multiple block variants (block_variants) for gradient effects
- Focus on a cohesive, simple color palette rather than many colors

CRITICAL REQUIREMENTS FOR BLOCK DIVERSITY:
- ALWAYS provide "block_variants" array with 2-3 alternative blocks for each color
- Use VARIETY: Mix wool, concrete, terracotta, and special blocks for gradients within each color
- PRIORITY BLOCKS: When color matches, ALWAYS prioritize these blocks in block_variants: gold_block, glowstone, quartz_block, spruce_leaves
- For RED: Consider red_wool, red_concrete, red_terracotta, netherrack
- For WHITE: PRIORITIZE quartz_block, then white_wool, white_concrete, snow_block
- For GREEN: PRIORITIZE spruce_leaves, then green_wool, green_concrete, green_terracotta, emerald_block, lime_wool
- For BLUE: Consider blue_wool, blue_concrete, blue_terracotta, lapis_block, light_blue_wool
- For YELLOW: PRIORITIZE gold_block, then yellow_wool, yellow_concrete, yellow_terracotta, glowstone
- For BROWN: Consider brown_wool, brown_concrete, brown_terracotta, dirt, coarse_dirt
- For ORANGE: Consider orange_wool, orange_concrete, orange_terracotta, pumpkin, glowstone
- For PURPLE/PINK: Consider purple_wool, magenta_wool, pink_wool, and their concrete/terracotta variants
- For HUMAN SKIN: ALWAYS use white_terracotta (PRIORITY #1) or smooth_sandstone (PRIORITY #2), NEVER yellow_wool (pink blocks are allowed if appropriate)
- For LIGHT/BRIGHT colors: PRIORITIZE glowstone and quartz_block when appropriate

SPECIFIC EXAMPLES:
- Christmas candy cane: red_wool/red_concrete/red_terracotta + quartz_block/white_wool/white_concrete in spiral pattern (2 colors, prioritize quartz_block for white)
- Christmas tree: spruce_leaves/green_wool/green_concrete/emerald_block for leaves, brown_wool/brown_concrete/dirt for trunk (2 colors, prioritize spruce_leaves)
- Presents: Use 2-3 colors max, each with multiple variants. For highlights/decorations, prioritize gold_block and glowstone when appropriate
- Snowman: quartz_block/white_wool/white_concrete/snow_block for body (prioritize quartz_block), black_wool/black_concrete/obsidian for eyes (2 colors)
- Decorative elements: When using bright/yellow colors, prioritize gold_block and glowstone. For white/light colors, prioritize quartz_block. For green foliage, prioritize spruce_leaves

RGB values should be 0-255. Return ONLY valid JSON, no markdown.`;

            const completion = await callOpenAIWithRetry(() =>
                openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        { role: 'system', content: 'You are a Minecraft color expert. Generate color schemes as JSON only.' },
                        { role: 'user', content: colorPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 500
                })
            );

            const responseText = completion.choices[0].message.content.trim();
            // Extract JSON from markdown code blocks if present
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('AI did not return valid JSON');
            }
            
            const colorScheme = JSON.parse(jsonMatch[0]);
            
            // Limit to maximum 4 colors
            if (colorScheme.color_rules && colorScheme.color_rules.length > 4) {
                console.warn(`[SKILLS] ⚠️ AI generated ${colorScheme.color_rules.length} colors, limiting to 4`);
                colorScheme.color_rules = colorScheme.color_rules.slice(0, 4);
            }
            
            console.log(`[SKILLS] 🤖 AI Color Scheme (${colorScheme.color_rules?.length || 0} colors):`, JSON.stringify(colorScheme, null, 2));
            
            return colorScheme;
        } catch (error) {
            console.error(`[SKILLS] Error generating AI color scheme: ${error.message}`);
            // Fallback: return a simple color scheme based on prompt keywords
            const fallbackScheme = {
                color_rules: [],
                pattern: 'default'
            };
            
            // Simple keyword-based fallback with block variants
            const lowerPrompt = prompt.toLowerCase();
            if (lowerPrompt.includes('candy cane')) {
                fallbackScheme.color_rules = [
                    { 
                        condition: 'spiral or stripe pattern', 
                        rgb: [153, 51, 51], 
                        block: 'red_wool',
                        block_variants: ['red_concrete', 'red_terracotta']
                    },
                    { 
                        condition: 'alternating', 
                        rgb: [255, 255, 255], 
                        block: 'quartz_block', // PRIORITY: quartz_block
                        block_variants: ['white_wool', 'white_concrete', 'snow_block']
                    }
                ];
                fallbackScheme.pattern = 'red and white stripes';
                fallbackScheme.shape_hints = ['spiral', 'cylindrical'];
            } else if (lowerPrompt.includes('tree')) {
                fallbackScheme.color_rules = [
                    { 
                        condition: 'leaves', 
                        rgb: [127, 204, 25], 
                        block: 'spruce_leaves', // PRIORITY: spruce_leaves
                        block_variants: ['green_wool', 'green_concrete', 'emerald_block', 'lime_wool']
                    },
                    { 
                        condition: 'trunk', 
                        rgb: [102, 76, 51], 
                        block: 'brown_wool',
                        block_variants: ['brown_concrete', 'dirt', 'coarse_dirt']
                    }
                ];
                fallbackScheme.pattern = 'green leaves with brown trunk';
                fallbackScheme.shape_hints = ['layered', 'organic'];
            } else {
                // Default: colorful with variants
                fallbackScheme.color_rules = [
                    { 
                        condition: 'base', 
                        rgb: [153, 51, 51], 
                        block: 'red_wool',
                        block_variants: ['red_concrete', 'red_terracotta']
                    },
                    { 
                        condition: 'accent', 
                        rgb: [51, 76, 178], 
                        block: 'blue_wool',
                        block_variants: ['blue_concrete', 'lapis_block']
                    },
                    { 
                        condition: 'highlight', 
                        rgb: [229, 229, 51], 
                        block: 'gold_block', // PRIORITY: gold_block
                        block_variants: ['yellow_wool', 'yellow_concrete', 'glowstone']
                    }
                ];
                fallbackScheme.pattern = 'colorful';
                fallbackScheme.shape_hints = ['organic'];
            }
            
            // Ensure fallback scheme also respects 4-color limit
            if (fallbackScheme.color_rules && fallbackScheme.color_rules.length > 4) {
                console.warn(`[SKILLS] ⚠️ Fallback scheme has ${fallbackScheme.color_rules.length} colors, limiting to 4`);
                fallbackScheme.color_rules = fallbackScheme.color_rules.slice(0, 4);
            }
            
            console.log(`[SKILLS] Using fallback color scheme (${fallbackScheme.color_rules?.length || 0} colors):`, fallbackScheme);
            return fallbackScheme;
        }
    },

    /**
     * Analyze model shape to determine coloring strategy
     * @param {Array} blueprintData - Blueprint data with positions
     * @returns {Object} Shape analysis results
     */
    analyzeModelShape(blueprintData) {
        const bounds = {
            minX: Math.min(...blueprintData.map(e => e.x)),
            maxX: Math.max(...blueprintData.map(e => e.x)),
            minY: Math.min(...blueprintData.map(e => e.y)),
            maxY: Math.max(...blueprintData.map(e => e.y)),
            minZ: Math.min(...blueprintData.map(e => e.z)),
            maxZ: Math.max(...blueprintData.map(e => e.z))
        };
        
        const width = bounds.maxX - bounds.minX + 1;
        const height = bounds.maxY - bounds.minY + 1;
        const depth = bounds.maxZ - bounds.minZ + 1;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        
        // Analyze shape characteristics
        const shapeHints = [];
        
        // Check if cylindrical (similar width and depth, different height)
        const aspectRatioXY = width / height;
        const aspectRatioXZ = width / depth;
        const aspectRatioYZ = height / depth;
        if (Math.abs(width - depth) < Math.max(width, depth) * 0.3 && height > width * 1.5) {
            shapeHints.push('cylindrical');
        }
        
        // Check if spiral pattern (candy cane shape)
        if (height > width * 2 && Math.abs(width - depth) < Math.max(width, depth) * 0.2) {
            shapeHints.push('spiral');
        }
        
        // Check if layered (distinct horizontal layers)
        const layerCounts = {};
        blueprintData.forEach(e => {
            const layer = e.y;
            layerCounts[layer] = (layerCounts[layer] || 0) + 1;
        });
        const distinctLayers = Object.keys(layerCounts).length;
        if (distinctLayers > height * 0.7) {
            shapeHints.push('layered');
        }
        
        // Check if boxy (rectangular)
        if (Math.abs(aspectRatioXY - 1) < 0.3 && Math.abs(aspectRatioXZ - 1) < 0.3) {
            shapeHints.push('boxy');
        }
        
        // Calculate radial distances for spiral detection
        const radialDistances = blueprintData.map(e => {
            const dx = e.x - centerX;
            const dz = e.z - centerZ;
            return Math.sqrt(dx * dx + dz * dz);
        });
        const maxRadius = Math.max(...radialDistances);
        
        // ===== ENHANCED STRUCTURE DETECTION =====
        
        // Analyze volume distribution by height (for tree-like structures)
        const volumeByHeight = {};
        blueprintData.forEach(e => {
            const y = e.y;
            volumeByHeight[y] = (volumeByHeight[y] || 0) + 1;
        });
        
        // Calculate width/depth at different heights
        const widthByHeight = {};
        const depthByHeight = {};
        blueprintData.forEach(e => {
            const y = e.y;
            if (!widthByHeight[y]) {
                widthByHeight[y] = { minX: e.x, maxX: e.x, minZ: e.z, maxZ: e.z };
            } else {
                widthByHeight[y].minX = Math.min(widthByHeight[y].minX, e.x);
                widthByHeight[y].maxX = Math.max(widthByHeight[y].maxX, e.x);
                widthByHeight[y].minZ = Math.min(widthByHeight[y].minZ, e.z);
                widthByHeight[y].maxZ = Math.max(widthByHeight[y].maxZ, e.z);
            }
        });
        
        // Calculate average cross-sectional area at different heights
        const crossSectionByHeight = {};
        Object.keys(widthByHeight).forEach(y => {
            const w = widthByHeight[y];
            const wd = w.maxX - w.minX + 1;
            const dd = w.maxZ - w.minZ + 1;
            crossSectionByHeight[y] = wd * dd;
        });
        
        // Detect tree-like structure: wider at bottom, narrower at top
        const heightKeys = Object.keys(crossSectionByHeight).map(Number).sort((a, b) => a - b);
        if (heightKeys.length >= 3) {
            const bottomThird = Math.floor(heightKeys.length / 3);
            const topThird = Math.floor(heightKeys.length * 2 / 3);
            
            const bottomArea = heightKeys.slice(0, bottomThird).reduce((sum, y) => sum + (crossSectionByHeight[y] || 0), 0) / bottomThird;
            const middleArea = heightKeys.slice(bottomThird, topThird).reduce((sum, y) => sum + (crossSectionByHeight[y] || 0), 0) / (topThird - bottomThird);
            const topArea = heightKeys.slice(topThird).reduce((sum, y) => sum + (crossSectionByHeight[y] || 0), 0) / (heightKeys.length - topThird);
            
            // Tree-like: bottom > middle > top (tapering upward)
            const isTaperingUpward = bottomArea > middleArea && middleArea > topArea * 0.8;
            const hasSignificantTaper = bottomArea > topArea * 1.5;
            
            if (isTaperingUpward && hasSignificantTaper && height > width * 1.2) {
                shapeHints.push('tree-like');
                shapeHints.push('tapering');
            }
        }
        
        // Detect trunk (narrow vertical section at bottom)
        if (heightKeys.length >= 4) {
            const bottomQuarter = Math.floor(heightKeys.length / 4);
            const bottomHalf = Math.floor(heightKeys.length / 2);
            
            const bottomQuarterArea = heightKeys.slice(0, bottomQuarter).reduce((sum, y) => sum + (crossSectionByHeight[y] || 0), 0) / bottomQuarter;
            const secondQuarterArea = heightKeys.slice(bottomQuarter, bottomHalf).reduce((sum, y) => sum + (crossSectionByHeight[y] || 0), 0) / (bottomHalf - bottomQuarter);
            
            // Trunk detection: bottom section is significantly narrower than section above it
            const hasTrunk = bottomQuarterArea < secondQuarterArea * 0.7 && bottomQuarterArea < width * depth * 0.3;
            
            if (hasTrunk) {
                shapeHints.push('has-trunk');
                // Calculate trunk height threshold
                const trunkHeightThreshold = bounds.minY + (heightKeys[bottomQuarter] - bounds.minY);
            }
        }
        
        // Detect horizontal layers with different sizes (for layered structures)
        const layerSizes = heightKeys.map(y => crossSectionByHeight[y] || 0);
        const layerSizeVariance = this.calculateVariance(layerSizes);
        const avgLayerSize = layerSizes.reduce((a, b) => a + b, 0) / layerSizes.length;
        
        // High variance suggests distinct layers (like tree branches)
        if (layerSizeVariance > avgLayerSize * 0.5 && distinctLayers > height * 0.5) {
            shapeHints.push('distinct-layers');
        }
        
        // Detect vertical center concentration (for structures with central core)
        const centerConcentration = blueprintData.filter(e => {
            const dx = e.x - centerX;
            const dz = e.z - centerZ;
            const dist = Math.sqrt(dx * dx + dz * dz);
            return dist < maxRadius * 0.3;
        }).length / blueprintData.length;
        
        if (centerConcentration > 0.3) {
            shapeHints.push('center-concentrated');
        }
        
        // Calculate structure type inference
        let inferredStructure = null;
        if (shapeHints.includes('tree-like') && shapeHints.includes('has-trunk')) {
            inferredStructure = 'tree';
        } else if (shapeHints.includes('spiral')) {
            inferredStructure = 'cane';
        } else if (shapeHints.includes('cylindrical') && shapeHints.includes('layered')) {
            inferredStructure = 'tower';
        } else if (shapeHints.includes('boxy')) {
            inferredStructure = 'building';
        }
        
        return {
            bounds,
            width,
            height,
            depth,
            centerX,
            centerY,
            centerZ,
            shapeHints: shapeHints.length > 0 ? shapeHints : ['organic'],
            maxRadius,
            aspectRatios: { xy: aspectRatioXY, xz: aspectRatioXZ, yz: aspectRatioYZ },
            // Enhanced structure data
            volumeByHeight,
            crossSectionByHeight,
            layerSizes,
            inferredStructure,
            trunkHeightThreshold: shapeHints.includes('has-trunk') ? bounds.minY + (heightKeys[Math.floor(heightKeys.length / 4)] - bounds.minY) : null
        };
    },
    
    /**
     * Calculate variance of an array
     * @param {Array<number>} values - Array of numbers
     * @returns {number} Variance
     */
    calculateVariance(values) {
        if (values.length === 0) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
        return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    },

    /**
     * Select block variant for diversity
     * @param {Object} rule - Color rule with block and variants
     * @param {number} positionHash - Hash of position for consistent selection
     * @returns {string} Selected block name
     */
    selectBlockVariant(rule, positionHash) {
        const variants = rule.block_variants || [];
        let allBlocks = [rule.block, ...variants].filter(b => b);
        
        // PRIORITY BLOCKS: gold_block, glowstone, quartz_block, spruce_leaves
        const priorityBlocks = ['gold_block', 'glowstone', 'quartz_block', 'spruce_leaves'];
        
        // CRITICAL: Filter out pink blocks if condition indicates skin
        const condition = rule.condition ? rule.condition.toLowerCase() : '';
        const isSkinRelated = condition.includes('skin') || condition.includes('face') || 
                             condition.includes('body') || condition.includes('human') ||
                             condition.includes('character') || condition.includes('person');
        
        if (isSkinRelated) {
            // Remove yellow_wool from variants for skin colors (not suitable for skin)
            // Pink blocks are allowed for skin colors
            allBlocks = allBlocks.filter(b => {
                const blockName = b.toLowerCase().replace('minecraft:', '');
                return blockName !== 'yellow_wool';
            });
            // If no blocks left after filtering, use skin-appropriate blocks
            if (allBlocks.length === 0) {
                // PRIORITY: white_terracotta (most fit) or smooth_sandstone
                allBlocks = ['white_terracotta', 'smooth_sandstone'];
            } else {
                // Ensure skin blocks are prioritized: white_terracotta first, then smooth_sandstone
                const skinBlocks = ['white_terracotta', 'smooth_sandstone'];
                const hasSkinBlocks = allBlocks.some(b => {
                    const blockName = b.toLowerCase().replace('minecraft:', '');
                    return skinBlocks.includes(blockName);
                });
                // If skin blocks are not in the list, add them at the beginning
                if (!hasSkinBlocks) {
                    allBlocks = ['white_terracotta', 'smooth_sandstone', ...allBlocks];
                } else {
                    // Reorder to prioritize skin blocks
                    const skinInList = allBlocks.filter(b => {
                        const blockName = b.toLowerCase().replace('minecraft:', '');
                        return skinBlocks.includes(blockName);
                    });
                    const nonSkinInList = allBlocks.filter(b => {
                        const blockName = b.toLowerCase().replace('minecraft:', '');
                        return !skinBlocks.includes(blockName);
                    });
                    allBlocks = [...skinInList.sort((a, b) => {
                        const aName = a.toLowerCase().replace('minecraft:', '');
                        const bName = b.toLowerCase().replace('minecraft:', '');
                        return skinBlocks.indexOf(aName) - skinBlocks.indexOf(bName);
                    }), ...nonSkinInList];
                }
            }
        }
        
        if (allBlocks.length === 0) {
            return rule.block || 'white_wool';
        }
        
        // PRIORITY LOGIC: If any priority blocks are in the list, increase their selection probability
        // Check if any priority blocks match the color requirements
        const priorityMatches = allBlocks.filter(b => {
            const blockName = b.replace('minecraft:', '').toLowerCase();
            return priorityBlocks.includes(blockName);
        });
        
        // If priority blocks are available and match the color, use them more frequently
        if (priorityMatches.length > 0) {
            // 70% chance to use priority block, 30% chance to use other variants
            const usePriority = (Math.floor(positionHash) % 10) < 7;
            if (usePriority) {
                const priorityIndex = Math.floor(positionHash) % priorityMatches.length;
                return priorityMatches[priorityIndex].replace('minecraft:', '');
            }
        }
        
        // Use position hash to consistently select variant (ensures nearby blocks use same variant)
        const variantIndex = Math.floor(positionHash) % allBlocks.length;
        return allBlocks[variantIndex].replace('minecraft:', '');
    },

    /**
     * Apply AI-generated color scheme to blueprint with intelligent shape analysis
     * @param {Array} blueprintData - Blueprint data with positions
     * @param {Object} colorScheme - Color scheme from AI
     * @returns {Array} Blueprint with colors applied
     */
    applyAIColors(blueprintData, colorScheme) {
        // Ensure color scheme respects 4-color limit
        if (colorScheme.color_rules && colorScheme.color_rules.length > 4) {
            console.warn(`[SKILLS] ⚠️ Color scheme has ${colorScheme.color_rules.length} colors, limiting to 4`);
            colorScheme.color_rules = colorScheme.color_rules.slice(0, 4);
        }
        
        // Analyze model shape first
        const shapeAnalysis = this.analyzeModelShape(blueprintData);
        const { 
            bounds, width, height, depth, centerX, centerY, centerZ, 
            shapeHints, maxRadius, inferredStructure, trunkHeightThreshold,
            crossSectionByHeight, volumeByHeight
        } = shapeAnalysis;
        
        console.log(`[SKILLS] 🤖 Enhanced Shape Analysis:`, {
            hints: shapeHints,
            inferredStructure: inferredStructure || 'unknown',
            dimensions: `${width}x${height}x${depth}`,
            maxRadius: maxRadius.toFixed(2),
            trunkHeightThreshold: trunkHeightThreshold || 'none'
        });
        
        // Use shape hints from AI if available, otherwise use detected hints
        const effectiveHints = colorScheme.shape_hints || shapeHints;
        const isSpiral = effectiveHints.includes('spiral') || shapeHints.includes('spiral');
        const isCylindrical = effectiveHints.includes('cylindrical') || shapeHints.includes('cylindrical');
        const isLayered = effectiveHints.includes('layered') || shapeHints.includes('layered');
        const isTreeLike = effectiveHints.includes('tree-like') || shapeHints.includes('tree-like') || inferredStructure === 'tree';
        const hasTrunk = effectiveHints.includes('has-trunk') || shapeHints.includes('has-trunk');
        
        // Build position map for neighbor checking
        const positionMap = new Map();
        blueprintData.forEach((e, idx) => {
            const key = `${e.x},${e.y},${e.z}`;
            positionMap.set(key, idx);
        });
        
        // Apply color rules with intelligent pattern matching
        return blueprintData.map((entry, idx) => {
            const x = entry.x;
            const y = entry.y;
            const z = entry.z;
            
            // Calculate relative positions
            const relX = (x - bounds.minX) / width;
            const relY = (y - bounds.minY) / height;
            const relZ = (z - bounds.minZ) / depth;
            const distFromCenter = Math.sqrt(
                Math.pow((x - centerX) / width, 2) +
                Math.pow((y - centerY) / height, 2) +
                Math.pow((z - centerZ) / depth, 2)
            );
            
            // Calculate radial distance and angle for spiral patterns
            const dx = x - centerX;
            const dz = z - centerZ;
            const radialDist = Math.sqrt(dx * dx + dz * dz);
            const angle = Math.atan2(dz, dx);
            
            // Try to match color rules with improved pattern recognition
            let matchedRule = null;
            let matchScore = 0;
            
            // ===== ENHANCED STRUCTURE-AWARE COLOR MATCHING =====
            
            // Tree-like structure: intelligent trunk/crown detection
            let isTrunkRegion = false;
            let isCrownRegion = false;
            if (isTreeLike && trunkHeightThreshold !== null) {
                isTrunkRegion = y <= trunkHeightThreshold;
                isCrownRegion = y > trunkHeightThreshold;
            } else if (isTreeLike) {
                // Fallback: use relative height
                isTrunkRegion = relY < 0.25; // Bottom 25% is trunk
                isCrownRegion = relY > 0.25; // Top 75% is crown
            }
            
            for (const rule of colorScheme.color_rules) {
                const condition = rule.condition.toLowerCase();
                let score = 0;
                
                // ===== TREE STRUCTURE MATCHING (High Priority) =====
                if (isTreeLike) {
                    // Match "trunk", "stem", "base", "bottom" to trunk region
                    if ((condition.includes('trunk') || condition.includes('stem') || 
                         condition.includes('base') || condition.includes('bottom')) && isTrunkRegion) {
                        score = 15; // Very high priority for tree trunk
                    }
                    // Match "leaves", "crown", "top", "foliage" to crown region
                    else if ((condition.includes('leaves') || condition.includes('crown') || 
                              condition.includes('foliage') || condition.includes('top')) && isCrownRegion) {
                        score = 15; // Very high priority for tree crown
                    }
                    // Match "branch" to middle-upper regions
                    else if (condition.includes('branch') && relY > 0.3 && relY < 0.8) {
                        score = 12;
                    }
                }
                
                // ===== SPIRAL PATTERN (Candy Cane) =====
                if (condition.includes('spiral') && isSpiral) {
                    // Spiral pattern: alternate colors based on angle and height
                    const spiralIndex = Math.floor((angle + Math.PI) / (2 * Math.PI) * 4 + y * 0.3) % 2;
                    const targetColor = spiralIndex === 0 ? 'red' : 'white';
                    if (rule.block.toLowerCase().includes(targetColor)) {
                        score = Math.max(score, 10);
                    }
                }
                
                // ===== GENERAL POSITIONAL MATCHING =====
                if (condition.includes('stripe') || condition.includes('vertical')) {
                    // Vertical stripes: alternate based on X position
                    const stripeIndex = Math.floor((x - bounds.minX) / Math.max(width / 4, 1)) % 2;
                    score = Math.max(score, 5);
                } else if (condition.includes('horizontal') || condition.includes('band')) {
                    // Horizontal bands: alternate based on Y position
                    const bandIndex = Math.floor((y - bounds.minY) / Math.max(height / 4, 1)) % 2;
                    score = Math.max(score, 5);
                } else if (condition.includes('top') && relY > 0.6) {
                    score = Math.max(score, 8);
                } else if (condition.includes('bottom') || condition.includes('base')) {
                    if (relY < 0.3) score = Math.max(score, 8);
                } else if (condition.includes('center') || condition.includes('core')) {
                    if (distFromCenter < 0.4) score = Math.max(score, 7);
                } else if (condition.includes('outer') || condition.includes('edge')) {
                    if (distFromCenter > 0.6) score = Math.max(score, 6);
                } else if (condition.includes('layer') && isLayered) {
                    // Layer-based coloring
                    const layerIndex = Math.floor((y - bounds.minY) / Math.max(height / colorScheme.color_rules.length, 1));
                    const ruleIndex = layerIndex % colorScheme.color_rules.length;
                    if (rule === colorScheme.color_rules[ruleIndex]) {
                        score = Math.max(score, 9);
                    }
                }
                
                // ===== CYLINDRICAL PATTERN =====
                if (isCylindrical && condition.includes('center')) {
                    if (radialDist < maxRadius * 0.3) score += 3;
                }
                
                // ===== VOLUME-BASED MATCHING (for structures with varying cross-sections) =====
                if (crossSectionByHeight && crossSectionByHeight[y]) {
                    const currentCrossSection = crossSectionByHeight[y];
                    const avgCrossSection = Object.values(crossSectionByHeight).reduce((a, b) => a + b, 0) / Object.keys(crossSectionByHeight).length;
                    
                    // Match "wide" or "expanded" to regions with larger cross-section
                    if (condition.includes('wide') || condition.includes('expanded')) {
                        if (currentCrossSection > avgCrossSection * 1.2) {
                            score = Math.max(score, 7);
                        }
                    }
                    // Match "narrow" or "thin" to regions with smaller cross-section
                    if (condition.includes('narrow') || condition.includes('thin')) {
                        if (currentCrossSection < avgCrossSection * 0.8) {
                            score = Math.max(score, 7);
                        }
                    }
                }
                
                if (score > matchScore) {
                    matchScore = score;
                    matchedRule = rule;
                }
            }
            
            // If no rule matched well, use intelligent fallback
            if (!matchedRule || matchScore < 3) {
                if (colorScheme.color_rules.length > 0) {
                    // Distribute colors based on position for variety
                    // Use multiple factors to ensure good distribution
                    const colorIndex = Math.floor((x * 3 + y * 5 + z * 7) % colorScheme.color_rules.length);
                    matchedRule = colorScheme.color_rules[colorIndex];
                }
            }
            
            if (matchedRule) {
                // Select block variant for diversity
                const positionHash = (x * 31 + y * 17 + z * 13) % 1000;
                let selectedBlock = this.selectBlockVariant(matchedRule, positionHash);
                
                // CRITICAL: Skin color rule - check if condition or block indicates human skin
                const condition = matchedRule.condition ? matchedRule.condition.toLowerCase() : '';
                const isSkinRelated = condition.includes('skin') || condition.includes('face') || 
                                     condition.includes('body') || condition.includes('human') ||
                                     condition.includes('character') || condition.includes('person');
                
                // If skin-related, ensure we use appropriate skin blocks (white_terracotta or smooth_sandstone)
                // NEVER use yellow_wool for skin (pink blocks are allowed)
                if (isSkinRelated && selectedBlock) {
                    const blockName = selectedBlock.toLowerCase().replace('minecraft:', '');
                    const isInvalidSkinBlock = blockName === 'yellow_wool';
                    
                    if (isInvalidSkinBlock) {
                        // PRIORITY: white_terracotta (most fit) or smooth_sandstone
                        const brightness = (matchedRule.rgb[0] + matchedRule.rgb[1] + matchedRule.rgb[2]) / 3;
                        // Use white_terracotta as primary choice (most suitable for skin)
                        selectedBlock = 'white_terracotta';
                        // For very light skin, could also use smooth_sandstone, but white_terracotta is preferred
                        if (brightness > 240) {
                            // Very bright skin - still use white_terracotta (priority #1)
                            selectedBlock = 'white_terracotta';
                        }
                        console.log(`[SKILLS] 🎨 Skin color detected: Replaced invalid skin block (${blockName}) with ${selectedBlock}`);
                    }
                }
                
                return {
                    ...entry,
                    r: matchedRule.rgb[0],
                    g: matchedRule.rgb[1],
                    b: matchedRule.rgb[2],
                    block: selectedBlock
                };
            }
            
            return entry;
        });
    },

    /**
     * Detect object type from description/prompt
     * @param {string} prompt - Description or prompt text
     * @returns {string} Object type: 'cat', 'human', 'tree', 'snow', or null
     */
    detectObjectType(prompt) {
        if (!prompt) return null;
        const descLower = prompt.toLowerCase();
        
        // Cat detection
        if (descLower.includes('cat') || descLower.includes('kitten') || descLower.includes('feline')) {
            return 'cat';
        }
        
        // Human/Person detection
        if (descLower.includes('human') || descLower.includes('person') || descLower.includes('people') ||
            descLower.includes('man') || descLower.includes('woman') || descLower.includes('character') ||
            descLower.includes('face') || descLower.includes('body')) {
            return 'human';
        }
        
        // Tree detection
        if (descLower.includes('tree') || descLower.includes('trunk') || descLower.includes('foliage') ||
            descLower.includes('leaves') || descLower.includes('branch')) {
            return 'tree';
        }
        
        // Snow/Snowman detection
        if (descLower.includes('snow') || descLower.includes('snowman') || descLower.includes('snowball')) {
            return 'snow';
        }
        
        return null;
    },

    /**
     * Apply material-based block adjustments based on object type
     * STRICT RULES:
     * - Cat -> wool blocks
     * - Human -> terracotta for skin (only), other materials as appropriate
     * - Tree -> wood for trunk, leaves for foliage
     * - Snow -> snow_block or quartz_block (NEVER white_terracotta)
     * @param {Array} blueprint - Blueprint array
     * @param {string} objectType - Object type from detectObjectType
     * @param {Array} blueprintData - Original blueprint data with RGB info
     * @returns {Array} Adjusted blueprint array
     */
    applyMaterialRules(blueprint, objectType, blueprintData) {
        if (!objectType) return blueprint;
        
        console.log(`[SKILLS] 🎨 Applying material rules for object type: ${objectType}`);
        
        // Create RGB lookup map from blueprintData
        const rgbMap = new Map();
        blueprintData.forEach((entry, idx) => {
            if (entry.r !== undefined && entry.g !== undefined && entry.b !== undefined) {
                const key = `${entry.x},${entry.y},${entry.z}`;
                rgbMap.set(key, { r: entry.r, g: entry.g, b: entry.b });
            }
        });
        
        // Calculate bounds for tree trunk detection
        let bounds = null;
        if (objectType === 'tree') {
            bounds = {
                minY: Math.min(...blueprint.map(e => e.pos.y)),
                maxY: Math.max(...blueprint.map(e => e.pos.y))
            };
        }
        
        return blueprint.map((entry, idx) => {
            const key = `${entry.pos.x},${entry.pos.y},${entry.pos.z}`;
            const rgb = rgbMap.get(key);
            const blockName = entry.block ? entry.block.toLowerCase().replace('minecraft:', '') : '';
            
            let newBlock = entry.block;
            
            switch (objectType) {
                case 'cat':
                    // Cat -> wool blocks (prefer colored wool, keep existing wool)
                    if (blockName.includes('terracotta') || blockName === 'quartz_block' || blockName === 'snow_block') {
                        // Map to appropriate wool color based on RGB
                        if (rgb) {
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 200) {
                                newBlock = 'white_wool';
                            } else if (brightness > 150) {
                                newBlock = 'light_gray_wool';
                            } else if (brightness > 100) {
                                newBlock = 'gray_wool';
                            } else {
                                newBlock = 'black_wool';
                            }
                        } else {
                            newBlock = 'white_wool'; // Default for cat
                        }
                    }
                    break;
                    
                case 'human':
                    // Human -> white_terracotta ONLY for skin colors
                    // Check if this is skin color (R > G > B pattern)
                    if (rgb) {
                        const isSkinColor = rgb.r > rgb.g && rgb.g > rgb.b &&
                            rgb.r >= 160 && rgb.r <= 255 &&
                            rgb.g >= 120 && rgb.g <= 230 &&
                            rgb.b >= 80 && rgb.b <= 200;
                        
                        if (isSkinColor) {
                            // Skin color -> white_terracotta or smooth_sandstone
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 200) {
                                newBlock = 'white_terracotta';
                            } else {
                                newBlock = 'smooth_sandstone';
                            }
                        } else if (blockName === 'white_terracotta') {
                            // NOT skin color but has white_terracotta -> replace with appropriate block
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 240) {
                                newBlock = 'snow_block';
                            } else {
                                newBlock = 'quartz_block';
                            }
                        }
                    }
                    break;
                    
                case 'tree':
                    // Tree -> wood for trunk (bottom 25%), leaves for foliage (top 75%)
                    if (bounds) {
                        const height = bounds.maxY - bounds.minY;
                        const trunkThreshold = bounds.minY + height * 0.25;
                        const isTrunk = entry.pos.y <= trunkThreshold;
                        
                        if (isTrunk) {
                            // Trunk -> wood blocks
                            if (blockName.includes('leaves') || blockName === 'green_wool' || blockName === 'green_concrete') {
                                newBlock = 'oak_log'; // Default wood
                            } else if (!blockName.includes('log') && !blockName.includes('wood')) {
                                // If not already wood, check RGB for brown tones
                                if (rgb) {
                                    const isBrown = rgb.r > rgb.g && rgb.b < rgb.r * 0.8;
                                    if (isBrown) {
                                        newBlock = 'oak_log';
                                    }
                                }
                            }
                        } else {
                            // Foliage -> leaves
                            if (blockName.includes('log') || blockName.includes('wood') || 
                                blockName === 'brown_wool' || blockName === 'brown_concrete') {
                                newBlock = 'oak_leaves'; // Default leaves
                            } else if (!blockName.includes('leaves')) {
                                // If not already leaves, check RGB for green tones
                                if (rgb) {
                                    const isGreen = rgb.g > rgb.r && rgb.g > rgb.b;
                                    if (isGreen) {
                                        newBlock = 'oak_leaves';
                                    }
                                }
                            }
                        }
                    }
                    break;
                    
                case 'snow':
                    // Snow -> snow_block or quartz_block (NEVER white_terracotta or smooth_sandstone)
                    // CRITICAL: Replace ALL inappropriate blocks for snow objects
                    if (blockName === 'white_terracotta' || blockName === 'smooth_sandstone') {
                        // Replace white_terracotta or smooth_sandstone with snow_block or quartz_block
                        if (rgb) {
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 240) {
                                newBlock = 'snow_block';
                            } else {
                                newBlock = 'quartz_block';
                            }
                        } else {
                            newBlock = 'snow_block'; // Default for snow
                        }
                    } else if (blockName === 'quartz_block' || blockName === 'white_concrete' || blockName === 'white_wool') {
                        // Prefer snow_block for very white colors in snow objects
                        if (rgb) {
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 240) {
                                newBlock = 'snow_block';
                            }
                        } else {
                            // Default to snow_block for snow objects
                            newBlock = 'snow_block';
                        }
                    } else {
                        // For any other block in snow objects, if it's light colored, prefer snow_block
                        if (rgb) {
                            const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                            if (brightness > 220 && !blockName.includes('black') && !blockName.includes('dark')) {
                                // Light colored block -> prefer snow_block for snow objects
                                newBlock = 'snow_block';
                            }
                        }
                    }
                    break;
            }
            
            return {
                ...entry,
                block: newBlock
            };
        });
    },

    /**
     * Execute Python voxelizer script and return blueprint data
     * @param {string} fullModelPath - Absolute path to model file
     * @param {string} outputPath - Path to output JSON file
     * @param {string} pythonScript - Path to Python script
     * @param {number} resolution - Voxelization resolution
     * @returns {Promise<Array>} Blueprint data array from JSON
     */
    async executeVoxelizer(fullModelPath, outputPath, pythonScript, resolution) {
            const isWindows = process.platform === 'win32';
            let pythonCommand = isWindows ? 'python' : 'python3';
            let command = `${pythonCommand} "${pythonScript}" "${fullModelPath}" "${outputPath}" ${resolution}`;
            let pythonError = null;
            
            console.log(`[SKILLS] Using Python command: ${pythonCommand}`);
            
            try {
                console.log(`[SKILLS] Executing: ${command}`);
                const { stdout, stderr } = await execAsync(command, {
                // Removed timeout - allow Python script to run as long as needed
                maxBuffer: 10 * 1024 * 1024
                });
                
                if (stderr && !stderr.includes('WARNING')) {
                    console.warn(`[SKILLS] Python stderr: ${stderr}`);
                }
                
                console.log(`[SKILLS] Python output: ${stdout}`);
            } catch (error) {
                // Try fallback Python commands
                let triedFallback = false;
                
                if (isWindows && (error.message.includes('python') || error.message.includes('not found') || error.message.includes('is not recognized'))) {
                    console.log(`[SKILLS] 'python' command failed, trying 'py'...`);
                    pythonCommand = 'py';
                    command = `${pythonCommand} "${pythonScript}" "${fullModelPath}" "${outputPath}" ${resolution}`;
                    triedFallback = true;
                } else if (!isWindows && (error.message.includes('python3') || error.message.includes('not found'))) {
                    console.log(`[SKILLS] python3 not found, trying python...`);
                    pythonCommand = 'python';
                    command = `${pythonCommand} "${pythonScript}" "${fullModelPath}" "${outputPath}" ${resolution}`;
                    triedFallback = true;
                }
                
                if (triedFallback) {
                    try {
                        console.log(`[SKILLS] Executing fallback: ${command}`);
                        const { stdout, stderr } = await execAsync(command, {
                            // Removed timeout - allow execution to take as long as needed
                            maxBuffer: 10 * 1024 * 1024
                        });
                        if (stderr && !stderr.includes('WARNING')) {
                            console.warn(`[SKILLS] Python stderr: ${stderr}`);
                        }
                        console.log(`[SKILLS] Python output: ${stdout}`);
                    pythonError = null;
                    } catch (error2) {
                        if (error2.stdout || error2.stderr || (error2.output && Array.isArray(error2.output))) {
                            pythonError = error2;
                        } else {
                            pythonError = {
                                message: error2.message || String(error2),
                                stdout: error2.stdout || '',
                                stderr: error2.stderr || '',
                                output: error2.output || [],
                                originalError: error2
                            };
                        }
                    }
                } else {
                    pythonError = error;
                }
            }
            
            if (pythonError) {
                let errorDetails = pythonError.message || String(pythonError);
                let stdout = '';
                let stderr = '';
                
                if (pythonError.stdout) {
                    stdout = pythonError.stdout;
                } else if (pythonError.output && Array.isArray(pythonError.output)) {
                    stdout = pythonError.output[1] || '';
                    stderr = pythonError.output[2] || '';
                }
                
                if (pythonError.stderr) {
                    stderr = pythonError.stderr;
                }
                
                console.error(`[SKILLS] Python execution failed. Error message:`, errorDetails);
                if (stdout) {
                    console.error(`[SKILLS] Python STDOUT:`, stdout);
                    errorDetails += `\n[STDOUT] ${stdout}`;
                }
                if (stderr) {
                    console.error(`[SKILLS] Python STDERR:`, stderr);
                    errorDetails += `\n[STDERR] ${stderr}`;
                }
                
                if (!stdout && !stderr) {
                    console.error(`[SKILLS] No stdout/stderr captured. Error object keys:`, Object.keys(pythonError));
                    console.error(`[SKILLS] Full error object:`, JSON.stringify(pythonError, Object.getOwnPropertyNames(pythonError)));
                }
                
                throw new Error(`Python execution failed: ${errorDetails}. Make sure Python is installed and trimesh/numpy/scipy are installed (pip install -r requirements.txt)`);
            }
            
            // Read generated JSON
            if (!fs.existsSync(outputPath)) {
                throw new Error('Python script did not generate output file. Check Python output for errors.');
            }
            
            let blueprintData;
            try {
                const jsonContent = fs.readFileSync(outputPath, 'utf-8');
                blueprintData = JSON.parse(jsonContent);
        } catch (parseError) {
            throw new Error(`Failed to parse blueprint JSON: ${parseError.message}. The Python script may have failed.`);
        }
        
        if (!Array.isArray(blueprintData) || blueprintData.length === 0) {
            throw new Error('Generated blueprint is empty or invalid. The model may be too small or voxelization failed.');
        }
        
        return blueprintData;
    },

    /**
     * Process 3D model file and convert to blueprint
     * Processes 3D model without any block count restrictions
     * @param {string} modelPath - Path to 3D model file
     * @param {number} resolution - Voxelization resolution (default: 32 for HD mode)
     * @param {string} prompt - Optional prompt for AI coloring if model has no colors
     * @returns {Promise<Array>} Blueprint array
     */
    async process3DModel(modelPath, resolution = 32, prompt = null) {
        try {
            console.log(`[SKILLS] Processing 3D model: ${modelPath}`);
            // Natural, engaging message about transforming the model
            const processingMessages = [
                `✨ Now let me transform this beautiful creation into blocks...`,
                `🎨 Converting this vision into Minecraft blocks - this is magical!`,
                `🌟 Adapting the design for our blocky world...`,
                `🎄 Translating this creation into our building blocks...`,
                `✨ This is fascinating! Converting the form into blocks...`
            ];
            bot.chat(processingMessages[Math.floor(Math.random() * processingMessages.length)]);
            
            // Ensure file exists
            const fullModelPath = path.isAbsolute(modelPath) ? modelPath : path.join(__dirname, modelPath);
            if (!fs.existsSync(fullModelPath)) {
                throw new Error(`Model file not found: ${fullModelPath}`);
            }
            
            // Validate file size (prevent processing huge files)
            const stats = fs.statSync(fullModelPath);
            const maxSize = 50 * 1024 * 1024; // 50MB limit
            if (stats.size > maxSize) {
                throw new Error(`Model file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max: 50MB). Try reducing resolution or using a smaller model.`);
            }
            
            // Generate output file path
            const assetsDir = path.join(__dirname, 'assets');
            if (!fs.existsSync(assetsDir)) {
                fs.mkdirSync(assetsDir, { recursive: true });
            }
            
            const outputPath = path.join(assetsDir, 'temp_blueprint.json');
            // Use PBR-aware voxelizer for better texture extraction
            const pythonScript = path.join(__dirname, 'voxelizer_pbr.py');
            
            // Validate Python script exists
            if (!fs.existsSync(pythonScript)) {
                throw new Error(`Python voxelizer script not found: ${pythonScript}. Please ensure voxelizer.py exists in the project root.`);
            }
            
            // Validate resolution
            if (resolution < 5 || resolution > 50) {
                console.warn(`[SKILLS] Resolution ${resolution} is outside recommended range (5-50), adjusting...`);
                resolution = Math.max(5, Math.min(50, resolution));
            }
            
            // NO BLOCK COUNT RESTRICTIONS - Process model at requested resolution without any limits
            let savedColorScheme = null;
            
            // Execute voxelization at requested resolution (no retries, no limits)
            console.log(`[SKILLS] 🧊 Voxelizing with resolution: ${resolution} (NO BLOCK LIMITS)`);
            
            // Call Python to execute voxelization
            let blueprintData;
            try {
                blueprintData = await this.executeVoxelizer(fullModelPath, outputPath, pythonScript, resolution);
                
                // Debug: Check first few entries
                if (blueprintData.length > 0) {
                    console.log(`[SKILLS] Sample entry from JSON:`, JSON.stringify(blueprintData[0], null, 2));
                    console.log(`[SKILLS] Entry keys:`, Object.keys(blueprintData[0]));
                    
                    const sampleColors = new Set();
                    const sampleBlocks = new Set();
                    blueprintData.slice(0, 100).forEach(entry => {
                        if (entry.r !== undefined && entry.g !== undefined && entry.b !== undefined) {
                            sampleColors.add(`${entry.r},${entry.g},${entry.b}`);
                        }
                        if (entry.block) {
                            sampleBlocks.add(entry.block);
                        }
                    });
                    console.log(`[SKILLS] Color check (first 100 entries):`);
                    console.log(`[SKILLS]   - Unique RGB colors: ${sampleColors.size}`);
                    console.log(`[SKILLS]   - Unique blocks: ${sampleBlocks.size}`);
                }
            } catch (error) {
                throw error; // Propagate Python execution errors
            }
            
            // Convert to blueprint format
            let blueprint = blueprintData.map(entry => {
                const blockName = entry.block;
                if (!blockName) {
                    console.warn(`[SKILLS] Missing block field for entry at (${entry.x}, ${entry.y}, ${entry.z}), using default`);
                }
                return {
                    block: blockName || 'quartz_block',
                    pos: new Vec3(entry.x || 0, entry.y || 0, entry.z || 0),
                    _debug_rgb: entry.r !== undefined ? {r: entry.r, g: entry.g, b: entry.b} : null
                };
            });
            
            // Log block count (no limit check)
            const count = blueprint.length;
            console.log(`[SKILLS] 📊 Generated ${count} blocks (NO LIMITS - Building all blocks)`);
            
            // Process AI coloring if needed
            if (!savedColorScheme) {
            const blockCounts = {};
            blueprint.forEach(entry => {
                blockCounts[entry.block] = (blockCounts[entry.block] || 0) + 1;
            });
            const uniqueBlocks = Object.keys(blockCounts);
            const totalBlocks = blueprint.length;
            const whiteWoolCount = blockCounts['white_wool'] || 0;
            const quartzBlockCount = blockCounts['quartz_block'] || 0;
            
            const uniqueRGBColors = new Set();
            blueprintData.forEach(entry => {
                if (entry.r !== undefined && entry.g !== undefined && entry.b !== undefined) {
                    uniqueRGBColors.add(`${entry.r},${entry.g},${entry.b}`);
                }
            });
            const colorCount = uniqueRGBColors.size;
            const isMonochrome = colorCount <= 1 || (colorCount <= 3 && whiteWoolCount + quartzBlockCount > totalBlocks * 0.9);
            
                // AI coloring logic
                if (uniqueBlocks.length === 1 && isMonochrome && prompt) {
                console.warn(`[SKILLS] ⚠️  COLOR MAPPING ISSUE: Only one block type found: ${uniqueBlocks[0]}`);
                console.log(`[SKILLS] 🤖 Will trigger AI coloring to add colors...`);
                    try {
                        console.log(`[SKILLS] 🤖 Attempting AI coloring with prompt: "${prompt}"`);
                        const colorScheme = await this.generateAIColorScheme(prompt, blueprintData);
                        savedColorScheme = colorScheme;
                        console.log(`[SKILLS] 🤖 Applying AI color scheme: ${colorScheme.pattern}`);
                        
                        blueprintData = this.applyAIColors(blueprintData, colorScheme);
                        blueprint = blueprintData.map(entry => {
                            return {
                                block: entry.block || 'white_wool',
                                pos: new Vec3(entry.x || 0, entry.y || 0, entry.z || 0),
                                _debug_rgb: entry.r !== undefined ? {r: entry.r, g: entry.g, b: entry.b} : null
                            };
                        });
                        
                        const newBlockCounts = {};
                        blueprint.forEach(entry => {
                            newBlockCounts[entry.block] = (newBlockCounts[entry.block] || 0) + 1;
                        });
                        console.log(`[SKILLS] 🤖 AI Coloring complete! New block distribution:`, newBlockCounts);
                        bot.chat(`✨ AI has added beautiful colors! The ${colorScheme.pattern} pattern should make it look much better!`);
                    } catch (aiError) {
                        console.error(`[SKILLS] AI coloring failed: ${aiError.message}`);
                }
                } else if (isMonochrome && whiteWoolCount + quartzBlockCount > totalBlocks * 0.9 && prompt && !savedColorScheme) {
                    console.warn(`[SKILLS] ⚠️  COLOR MAPPING ISSUE: Model appears monochrome`);
                    try {
                        const colorScheme = await this.generateAIColorScheme(prompt, blueprintData);
                        savedColorScheme = colorScheme;
                        blueprintData = this.applyAIColors(blueprintData, colorScheme);
                        blueprint = blueprintData.map(entry => {
                            return {
                                block: entry.block || 'white_wool',
                                pos: new Vec3(entry.x || 0, entry.y || 0, entry.z || 0),
                                _debug_rgb: entry.r !== undefined ? {r: entry.r, g: entry.g, b: entry.b} : null
                            };
                        });
                        bot.chat(`✨ AI has added beautiful colors! The ${colorScheme.pattern} pattern should make it look much better!`);
                    } catch (aiError) {
                        console.error(`[SKILLS] AI coloring failed: ${aiError.message}`);
                }
            } else {
                console.log(`[SKILLS] ✓ Color mapping successful: ${uniqueBlocks.length} unique block types`);
                console.log(`[SKILLS] ✓ PBR texture extraction succeeded - no AI coloring needed!`);
            }
            }
            
            // Apply material-based rules based on object type
            // CRITICAL: This ensures proper material mapping (cat->wool, human->terracotta for skin only, tree->wood/leaves, snow->snow_block/quartz)
            const objectType = this.detectObjectType(prompt);
            if (objectType) {
                console.log(`[SKILLS] 🎨 Detected object type: ${objectType}, applying material rules...`);
                
                // Count white_terracotta before adjustment
                const whiteTerracottaBefore = blueprint.filter(e => e.block && e.block.toLowerCase().includes('white_terracotta')).length;
                
                blueprint = this.applyMaterialRules(blueprint, objectType, blueprintData);
                
                // Count white_terracotta after adjustment
                const whiteTerracottaAfter = blueprint.filter(e => e.block && e.block.toLowerCase().includes('white_terracotta')).length;
                
                // Log material adjustments
                const adjustedBlockCounts = {};
                blueprint.forEach(entry => {
                    adjustedBlockCounts[entry.block] = (adjustedBlockCounts[entry.block] || 0) + 1;
                });
                console.log(`[SKILLS] 🎨 Material rules applied! Block distribution:`, adjustedBlockCounts);
                if (whiteTerracottaBefore !== whiteTerracottaAfter) {
                    console.log(`[SKILLS] 🎨 White terracotta count: ${whiteTerracottaBefore} -> ${whiteTerracottaAfter} (adjusted for ${objectType})`);
                }
            } else {
                // Even if object type is not detected, ensure white_terracotta is not overused
                // Replace white_terracotta that are not skin colors with snow_block or quartz_block
                const whiteTerracottaCount = blueprint.filter(e => e.block && e.block.toLowerCase().includes('white_terracotta')).length;
                if (whiteTerracottaCount > blueprint.length * 0.3) {
                    // Too many white_terracotta - likely not all are skin colors
                    console.log(`[SKILLS] 🎨 Warning: High white_terracotta usage (${whiteTerracottaCount}/${blueprint.length}), applying safety adjustments...`);
                    blueprint = blueprint.map(entry => {
                        const blockName = entry.block ? entry.block.toLowerCase().replace('minecraft:', '') : '';
                        if (blockName === 'white_terracotta') {
                            // Check if this might be skin color by looking at RGB
                            const key = `${entry.pos.x},${entry.pos.y},${entry.pos.z}`;
                            const rgb = blueprintData.find(e => `${e.x},${e.y},${e.z}` === key);
                            if (rgb && rgb.r !== undefined) {
                                const isSkinColor = rgb.r > rgb.g && rgb.g > rgb.b &&
                                    rgb.r >= 160 && rgb.r <= 255 &&
                                    rgb.g >= 120 && rgb.g <= 230 &&
                                    rgb.b >= 80 && rgb.b <= 200;
                                if (!isSkinColor) {
                                    // Not skin color -> replace with snow_block or quartz_block
                                    const brightness = (rgb.r + rgb.g + rgb.b) / 3;
                                    return {
                                        ...entry,
                                        block: brightness > 240 ? 'snow_block' : 'quartz_block'
                                    };
                                }
                            } else {
                                // No RGB info -> replace with snow_block
                                return {
                                    ...entry,
                                    block: 'snow_block'
                                };
                            }
                        }
                        return entry;
                    });
                }
            }
            
            // Log final statistics
            const blockCounts = {};
                    blueprint.forEach(entry => {
                blockCounts[entry.block] = (blockCounts[entry.block] || 0) + 1;
                    });
            console.log(`[SKILLS] Final blueprint size: ${blueprint.length} blocks (NO LIMITS)`);
            console.log(`[SKILLS] Block color distribution:`, blockCounts);
            
            // Verify color mapping - check if blocks are diverse (not all default)
            const uniqueBlockTypes = new Set(blueprint.map(e => e.block));
            const defaultBlockCount = blueprint.filter(e => e.block === 'quartz_block').length;
            if (defaultBlockCount === blueprint.length) {
                console.warn(`[SKILLS] WARNING: All blocks are default (quartz_block). Color mapping may have failed!`);
            } else {
                console.log(`[SKILLS] Color mapping successful: ${uniqueBlockTypes.size} unique block types used`);
            }
            
            console.log(`[SKILLS] Converted ${blueprint.length} voxels to blueprint`);
            // Natural, exciting message about the blueprint
            const blueprintMessages = [
                `✨ Perfect! I've created a blueprint with ${blueprint.length} blocks - this is going to look amazing!`,
                `🎨 Wonderful! The design is ready with ${blueprint.length} blocks. Let's build it!`,
                `🌟 Incredible! I've mapped out ${blueprint.length} blocks for this creation!`,
                `🎄 Excellent! The blueprint has ${blueprint.length} blocks - this will be beautiful!`,
                `✨ Amazing! I've prepared ${blueprint.length} blocks for this wonderful structure!`
            ];
            bot.chat(blueprintMessages[Math.floor(Math.random() * blueprintMessages.length)]);
            
            return blueprint;
            
        } catch (error) {
            console.error(`[SKILLS] Error processing 3D model: ${error.message}`);
            // Error logged to console only, not shown in game
            
            // Provide helpful error messages in console
            if (error.message.includes('Python') || error.message.includes('python')) {
                console.error(`[SKILLS] Tip: Make sure Python is installed and dependencies are installed: pip install -r requirements.txt`);
            } else if (error.message.includes('not found')) {
                console.error(`[SKILLS] Tip: Check that the model file exists and the path is correct.`);
            }
            
            throw error;
        }
    },

    /**
     * Download 3D model from URL
     * @param {string} url - URL to download from
     * @param {string} destPath - Destination file path
     * @returns {Promise<string>} Path to downloaded file
     */
    async downloadModel(url, destPath) {
        return new Promise((resolve, reject) => {
            const assetsDir = path.join(__dirname, 'assets');
            if (!fs.existsSync(assetsDir)) {
                fs.mkdirSync(assetsDir, { recursive: true });
            }
            
            const fullDestPath = path.isAbsolute(destPath) ? destPath : path.join(assetsDir, destPath);
            const file = fs.createWriteStream(fullDestPath);
            
            const protocol = url.startsWith('https') ? https : http;
            
            // No timeout - allow download to take as long as needed
            const request = protocol.get(url, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    file.close();
                    fs.unlinkSync(fullDestPath);
                    return this.downloadModel(response.headers.location, destPath).then(resolve).catch(reject);
                }
                
                if (response.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(fullDestPath);
                    reject(new Error(`Download failed with status ${response.statusCode}`));
                    return;
                }
                
                // Check content length
                const contentLength = parseInt(response.headers['content-length'] || '0');
                const maxSize = 100 * 1024 * 1024; // 100MB limit
                if (contentLength > maxSize) {
                    file.close();
                    fs.unlinkSync(fullDestPath);
                    reject(new Error(`File too large: ${(contentLength / 1024 / 1024).toFixed(2)}MB (max: 100MB)`));
                    return;
                }
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    console.log(`[SKILLS] Downloaded model to: ${fullDestPath}`);
                    resolve(fullDestPath);
                });
            });
            
            request.on('error', (err) => {
                file.close();
                if (fs.existsSync(fullDestPath)) {
                    fs.unlinkSync(fullDestPath);
                }
                reject(new Error(`Download error: ${err.message}`));
            });
            
            // Removed timeout - download can take as long as needed
        });
    },

    /**
     * Generate 3D model using Meshy/Tripo API
     * @param {string} prompt - Text description of the model
     * @returns {Promise<string>} URL to download the generated model
     */
    async generate3DModelWithAPI(prompt) {
        // Check for API keys
        const meshyKey = process.env.MESHY_API_KEY;
        const tripoKey = process.env.TRIPO_API_KEY;
        
        if (!meshyKey && !tripoKey) {
            throw new Error('No 3D generation API key found. Please set MESHY_API_KEY or TRIPO_API_KEY in .env file, or use manual file upload.');
        }
        
        // Check if Tripo key format looks like a task key (tsk_ prefix)
        if (tripoKey && tripoKey.startsWith('tsk_')) {
            console.warn(`[WARNING] TRIPO_API_KEY starts with 'tsk_' - this might be a task key, not an API key.`);
            console.warn(`[WARNING] Please check Tripo dashboard for the correct API key format.`);
            console.warn(`[WARNING] Task keys (tsk_) are used to track tasks, not authenticate API calls.`);
        }
        
        // Prefer Tripo if both are available (faster: ~10s vs ~30s)
        if (tripoKey) {
            return await this.generateWithTripo(prompt, tripoKey);
        } else if (meshyKey) {
            return await this.generateWithMeshy(prompt, meshyKey);
        } else {
            throw new Error('No API key available');
        }
    },

    /**
     * Generate model using Meshy API
     */
    async generateWithMeshy(prompt, apiKey) {
        // Meshy API implementation
        // Note: This is a placeholder - actual API endpoints may vary
        // Natural message for Meshy (though Tripo is preferred)
        const meshyMessages = [
            `✨ Creating something wonderful with advanced magic... This might take a moment!`,
            `🎨 Crafting this vision with creative technology...`,
            `🌟 Using some incredible tools to bring this to life...`
        ];
        bot.chat(meshyMessages[Math.floor(Math.random() * meshyMessages.length)]);
        
        // TODO: Implement actual Meshy API call
        // For now, throw error to indicate API integration needed
        throw new Error('Meshy API integration not yet implemented. Please use manual file upload or implement API client.');
    },

    /**
     * Generate model using Tripo API
     * API Documentation: https://www.tripo3d.ai/docs
     * DEBUG MODE: All errors are logged in detail, no fallback
     */
    async generateWithTripo(prompt, apiKey) {
        const debugPrefix = '[TRIPO DEBUG]';
        console.log(`${debugPrefix} ========================================`);
        console.log(`${debugPrefix} Starting Tripo API call`);
        console.log(`${debugPrefix} Prompt: "${prompt}"`);
        console.log(`${debugPrefix} API Key: ${apiKey ? apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 5) : 'MISSING'}`);
        console.log(`${debugPrefix} ========================================`);
        
        try {
            // Natural, exciting message that implies AI magic without being too technical
            const excitementMessages = [
                `✨ Ooh, this is exciting! I'm conjuring up a ${prompt} in my mind...`,
                `🎨 Let me imagine this ${prompt}... This is going to be amazing!`,
                `🌟 Creating something magical here... Visualizing a ${prompt}...`,
                `🎄 Wow, a ${prompt}! Let me bring this vision to life...`,
                `✨ This is incredible! I'm crafting the perfect ${prompt} in my imagination...`
            ];
            bot.chat(excitementMessages[Math.floor(Math.random() * excitementMessages.length)]);
            
            // Tripo API endpoint for text-to-3D
            // Base URL: https://api.tripo3d.ai/v2/openapi
            // Endpoint: POST /v2/openapi/task (per API docs)
            // Request body: {"type": "text_to_model", "prompt": "..."}
            const apiPath = '/v2/openapi/task'; // Correct endpoint per API docs
            const apiUrl = `https://api.tripo3d.ai${apiPath}`;
            console.log(`${debugPrefix} API Endpoint: ${apiUrl}`);
            console.log(`${debugPrefix} Base URL: https://api.tripo3d.ai/v2/openapi`);
            console.log(`${debugPrefix} Using path: ${apiPath}`);
            
            // Create task - per API docs format
            // Use prompt as-is (LLM should have confirmed with user)
            // Enhance prompt to explicitly request colors/textures for better color extraction
            // According to Tripo AI docs, there are two modes:
            // 1. One-click generation: Generates models with PBR textures automatically
            // 2. Build & Refine: Starts with untextured base model
            // We want the one-click generation mode for colors/textures
            
            // Magicavoxel style prompt enhancement
            // Magicavoxel is a voxel art editor - we want models that look like they were made in Magicavoxel
            // Key characteristics: blocky voxel art, low poly, clear edges, vibrant colors, simplified geometry
            const magicavoxelStyle = ', Magicavoxel style, voxel art, blocky voxel model, low poly voxel, cubic voxel design, pixelated voxel art, Minecraft-style voxel, block-based voxel sculpture, voxelized model, clear block edges, vibrant voxel colors, simplified voxel geometry, retro voxel game style, 8-bit voxel art';
            
            // Enhanced prompt: original + Magicavoxel style + color/texture requirements
            // Note: This model will be voxelized and rebuilt in Minecraft, so we need:
            // 1. Magicavoxel-style blocky voxel art that's already optimized for voxelization
            // 2. Clear colors/textures for block mapping
            // 3. Block-based structure that translates perfectly to Minecraft blocks
            const enhancedPrompt = `${prompt}${magicavoxelStyle}, colorful, vibrant colors, detailed textures, high quality materials, PBR textures, textured model, optimized for voxel reconstruction in Minecraft`;
            
            // Tripo API request body - only include supported parameters
            // Note: negative_prompt may not be supported by Tripo API, so we include negative requirements in the main prompt instead
            const requestBody = {
                type: 'text_to_model', // Required: task type
                prompt: enhancedPrompt // Enhanced prompt with Magicavoxel style + color/texture request + negative requirements
            };
            
            // If Tripo API supports negative_prompt, uncomment below:
            // requestBody.negative_prompt = 'low quality, blurry, distorted, monochrome, grayscale, untextured, no texture, wireframe, uncolored, overly complex geometry, fine details, intricate curves, high polygon count, realistic human features, photorealistic, smooth surfaces, organic curves, high detail, realistic textures, fur texture, soft edges, rounded, curved, organic shapes, smooth transitions, realistic materials';
            const postData = JSON.stringify(requestBody);
            console.log(`${debugPrefix} Request Body:`, JSON.stringify(requestBody, null, 2));
            
            // NOTE: Mineflayer automatically handles keepalive packets from the server.
            // We do NOT need to manually send keepalive - doing so causes protocol violations
            // that result in immediate disconnection. The async HTTP request allows the
            // event loop to process Mineflayer's protocol messages correctly.
            
            const createResponse = await new Promise((resolve, reject) => {
                const options = {
                    hostname: 'api.tripo3d.ai',
                    path: apiPath, // Use /v2/openapi/text-to-3d
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Length': Buffer.byteLength(postData)
                    }
                };
                
                console.log(`${debugPrefix} Request Options:`, {
                    hostname: options.hostname,
                    path: options.path,
                    method: options.method,
                    headers: {
                        'Content-Type': options.headers['Content-Type'],
                        'Authorization': `Bearer ${apiKey.substring(0, 10)}...`,
                        'Content-Length': options.headers['Content-Length']
                    }
                });
                
                const req = https.request(options, (res) => {
                    let data = '';
                    const statusCode = res.statusCode;
                    const headers = res.headers;
                    
                    console.log(`${debugPrefix} Response Status: ${statusCode}`);
                    console.log(`${debugPrefix} Response Headers:`, JSON.stringify(headers, null, 2));
                    
                    // Handle redirects (301, 302, 307, 308)
                    if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
                        const redirectUrl = headers.location || headers.Location;
                        console.log(`${debugPrefix} Redirect detected (${statusCode}) to: ${redirectUrl}`);
                        
                        if (!redirectUrl) {
                            reject(new Error(`API returned redirect ${statusCode} but no Location header`));
                            return;
                        }
                        
                        // Parse redirect URL
                        let redirectHostname, redirectPath;
                        if (redirectUrl.startsWith('http://') || redirectUrl.startsWith('https://')) {
                            const url = new URL(redirectUrl);
                            redirectHostname = url.hostname;
                            redirectPath = url.pathname + url.search;
                        } else {
                            // Relative redirect
                            redirectHostname = options.hostname;
                            redirectPath = redirectUrl.startsWith('/') ? redirectUrl : options.path + '/' + redirectUrl;
                        }
                        
                        console.log(`${debugPrefix} Following redirect to: ${redirectHostname}${redirectPath}`);
                        
                        // Create new request with redirect URL
                        // IMPORTANT: For POST requests, we need to resend the body
                        const redirectOptions = {
                            hostname: redirectHostname,
                            path: redirectPath,
                            method: options.method,
                            headers: {
                                ...options.headers,
                                'Content-Length': Buffer.byteLength(postData) // Recalculate for redirect
                            }
                        };
                        
                        console.log(`${debugPrefix} Creating redirect request with POST data`);
                        
                        const redirectReq = https.request(redirectOptions, (redirectRes) => {
                            let redirectData = '';
                            console.log(`${debugPrefix} Redirect Response Status: ${redirectRes.statusCode}`);
                            
                            redirectRes.on('data', (chunk) => { 
                                redirectData += chunk;
                            });
                            
                            redirectRes.on('end', () => {
                                console.log(`${debugPrefix} Redirect Response Body:`, redirectData);
                                
                                if (redirectRes.statusCode === 200 || redirectRes.statusCode === 201) {
                                    try {
                                        const parsed = JSON.parse(redirectData);
                                        console.log(`${debugPrefix} Parsed Redirect Response:`, JSON.stringify(parsed, null, 2));
                                        
                                        // Check Tripo API unified response structure
                                        if (parsed.code !== undefined) {
                                            if (parsed.code === 0) {
                                                console.log(`${debugPrefix} Redirect API returned success (code: 0)`);
                                                resolve(parsed.data || parsed);
                                            } else {
                                                const errorMsg = parsed.message || 'Unknown error';
                                                const suggestion = parsed.suggestion || '';
                                                console.error(`${debugPrefix} Redirect API Error (code: ${parsed.code}):`, errorMsg);
                                                reject(new Error(`Tripo API error (code: ${parsed.code}): ${errorMsg}. ${suggestion}`));
                                                return;
                                            }
                                        } else {
                                            resolve(parsed);
                                        }
                                    } catch (e) {
                                        console.error(`${debugPrefix} Redirect JSON Parse Error:`, e);
                                        reject(new Error(`Failed to parse redirect response: ${e.message}. Raw: ${redirectData.substring(0, 500)}`));
                                    }
                                } else {
                                    reject(new Error(`Redirect response error ${redirectRes.statusCode}: ${redirectData}`));
                                }
                            });
                        });
                        
                        redirectReq.on('error', (e) => {
                            console.error(`${debugPrefix} Redirect Request Error:`, e);
                            reject(new Error(`Redirect request error: ${e.message}`));
                        });
                        
                        // Removed timeout - allow redirect request to take as long as needed
                        // No timeout handler - connection will stay open indefinitely
                        
                        // Write POST data to redirect request
                        redirectReq.write(postData);
                        redirectReq.end();
                        return;
                    }
                    
                    res.on('data', (chunk) => { 
                        data += chunk;
                        console.log(`${debugPrefix} Received chunk: ${chunk.length} bytes`);
                    });
                    
                    res.on('end', () => {
                        console.log(`${debugPrefix} Full Response Body:`, data);
                        console.log(`${debugPrefix} Response Body Length: ${data.length} bytes`);
                        console.log(`${debugPrefix} X-Tripo-Trace-ID: ${headers['x-tripo-trace-id'] || headers['X-Tripo-Trace-ID'] || 'not found'}`);
                        
                        if (res.statusCode === 200 || res.statusCode === 201) {
                            try {
                                const parsed = JSON.parse(data);
                                console.log(`${debugPrefix} Parsed Response:`, JSON.stringify(parsed, null, 2));
                                
                                // Check Tripo API unified response structure
                                // Success: {"code": 0, "data": {}}
                                // Error: {"code": non-zero, "message": "...", "suggestion": "..."}
                                if (parsed.code !== undefined) {
                                    if (parsed.code === 0) {
                                        // Success - data contains the actual response
                                        console.log(`${debugPrefix} API returned success (code: 0)`);
                                        console.log(`${debugPrefix} Response data:`, JSON.stringify(parsed.data, null, 2));
                                        resolve(parsed.data || parsed); // Return data field or full response
                                    } else {
                                        // Error response
                                        const errorMsg = parsed.message || 'Unknown error';
                                        const suggestion = parsed.suggestion || '';
                                        console.error(`${debugPrefix} API Error Response (code: ${parsed.code}):`, {
                                            code: parsed.code,
                                            message: errorMsg,
                                            suggestion: suggestion
                                        });
                                        reject(new Error(`Tripo API error (code: ${parsed.code}): ${errorMsg}. ${suggestion}`));
                                        return;
                                    }
                                } else {
                                    // Legacy format or direct response (no code field)
                                    console.log(`${debugPrefix} Response does not have 'code' field, using direct response`);
                                    resolve(parsed);
                                }
                            } catch (e) {
                                console.error(`${debugPrefix} JSON Parse Error:`, e);
                                console.error(`${debugPrefix} Raw Data:`, data);
                                reject(new Error(`Failed to parse API response: ${e.message}. Raw response: ${data.substring(0, 500)}`));
                            }
                        } else {
                            // Try to parse error response (might have code field)
                            let parsedError = null;
                            try {
                                parsedError = JSON.parse(data);
                            } catch (e) {
                                // Not JSON, continue with raw error
                            }
                            
                            console.error(`${debugPrefix} ========================================`);
                            console.error(`${debugPrefix} API ERROR RESPONSE`);
                            console.error(`${debugPrefix} Status Code: ${res.statusCode}`);
                            console.error(`${debugPrefix} Status Message: ${res.statusMessage}`);
                            console.error(`${debugPrefix} Response Body:`, data);
                            console.error(`${debugPrefix} Request Path: ${options.path}`);
                            console.error(`${debugPrefix} Request Hostname: ${options.hostname}`);
                            console.error(`${debugPrefix} Full Request URL: https://${options.hostname}${options.path}`);
                            console.error(`${debugPrefix} ========================================`);
                            
                            // Check if error response has unified format
                            if (parsedError && parsedError.code !== undefined) {
                                const errorMsg = parsedError.message || 'Unknown error';
                                const suggestion = parsedError.suggestion || '';
                                reject(new Error(`Tripo API error (code: ${parsedError.code}): ${errorMsg}. ${suggestion}`));
                                return;
                            }
                            
                            // Provide helpful error message
                            let errorMsg = `API error ${res.statusCode} ${res.statusMessage}`;
                            if (res.statusCode === 404) {
                                errorMsg += `. Endpoint not found: ${options.path}. This could mean:\n`;
                                errorMsg += `1. The API endpoint path is incorrect\n`;
                                errorMsg += `2. The API key format is wrong (tsk_ prefix might be a task key, not API key)\n`;
                                errorMsg += `3. Check Tripo API documentation for correct endpoint\n`;
                                errorMsg += `Response: ${data}`;
                            } else {
                                errorMsg += `: ${data}`;
                            }
                            
                            reject(new Error(errorMsg));
                        }
                    });
                });
                
                req.on('error', (e) => {
                    console.error(`${debugPrefix} Request Error:`, e);
                    console.error(`${debugPrefix} Error Stack:`, e.stack);
                    reject(new Error(`Request error: ${e.message}. Stack: ${e.stack}`));
                });
                
                // Removed timeout - allow request to take as long as needed
                // No timeout handler - connection will stay open indefinitely
                
                console.log(`${debugPrefix} Sending request...`);
                req.write(postData);
                req.end();
            });
            
            console.log(`${debugPrefix} Create Response Received:`, JSON.stringify(createResponse, null, 2));
            
            // Try multiple possible field names for task ID
            const taskId = createResponse.task_id || createResponse.id || createResponse.taskId || createResponse.data?.task_id || createResponse.data?.id;
            console.log(`${debugPrefix} Extracted Task ID:`, taskId);
            console.log(`${debugPrefix} Full Response Object Keys:`, Object.keys(createResponse));
            
            if (!taskId) {
                console.error(`${debugPrefix} Task ID not found in response!`);
                console.error(`${debugPrefix} Available fields:`, Object.keys(createResponse));
                throw new Error(`API did not return task ID. Response: ${JSON.stringify(createResponse)}`);
            }
            
            console.log(`${debugPrefix} Tripo task created successfully: ${taskId}`);
            // Natural message that implies progress without technical details
            const progressMessages = [
                `✨ The magic is happening! My creative process is working...`,
                `🎨 Amazing! The vision is taking shape...`,
                `🌟 This is so cool! I can feel it coming together...`,
                `🎄 Wonderful! The design is crystallizing in my mind...`,
                `✨ Incredible! The form is emerging beautifully...`
            ];
            bot.chat(progressMessages[Math.floor(Math.random() * progressMessages.length)]);
            
            // Poll for completion - no timeout, will continue until completion
            let attempts = 0;
            const pollingState = { lastProgressSent: 0 }; // Track progress messages
            
            // Infinite loop - will continue until status is 'completed', 'failed', etc.
            while (true) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                attempts++;
                
                // NOTE: Mineflayer automatically handles keepalive packets from the server.
                // We do NOT need to manually send keepalive - doing so causes protocol violations
                // that result in immediate disconnection. The event loop is free during the 5-second
                // wait, allowing Mineflayer to handle all protocol messages correctly.
                
                console.log(`${debugPrefix} Polling attempt ${attempts + 1}...`);
                
                const statusResponse = await new Promise((resolve, reject) => {
                    // Updated: use /v2/openapi/task/ (singular, not tasks) per API docs
                    const statusPath = `/v2/openapi/task/${taskId}`;
                    console.log(`${debugPrefix} Status Check Path: ${statusPath}`);
                    
                    const options = {
                        hostname: 'api.tripo3d.ai',
                        path: statusPath,
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`
                        }
                    };
                    
                    https.get(options, (res) => {
                        let data = '';
                        console.log(`${debugPrefix} Status Check Response: ${res.statusCode}`);
                        
                        res.on('data', (chunk) => { 
                            data += chunk;
                        });
                        
                        res.on('end', () => {
                            console.log(`${debugPrefix} Status Response Body:`, data);
                            
                            if (res.statusCode === 200) {
                                try {
                                    const parsed = JSON.parse(data);
                                    console.log(`${debugPrefix} Parsed Status:`, JSON.stringify(parsed, null, 2));
                                    resolve(parsed);
                                } catch (e) {
                                    console.error(`${debugPrefix} Status Parse Error:`, e);
                                    reject(new Error(`Failed to parse status response: ${e.message}. Raw: ${data}`));
                                }
                            } else {
                                console.error(`${debugPrefix} Status Check Error:`, {
                                    statusCode: res.statusCode,
                                    body: data
                                });
                                reject(new Error(`Status check error ${res.statusCode}: ${data}`));
                            }
                        });
                    }).on('error', (e) => {
                        console.error(`${debugPrefix} Status Check Request Error:`, e);
                        reject(new Error(`Status check error: ${e.message}. Stack: ${e.stack}`));
                    });
                });
                
                // Extract status from unified response structure per API docs
                // Status can be: queued, running, success, failed, banned, expired, cancelled, unknown
                const status = statusResponse.status || statusResponse.data?.status;
                const progress = statusResponse.progress || statusResponse.data?.progress || 0;
                const output = statusResponse.output || statusResponse.data?.output || {};
                
                console.log(`${debugPrefix} Current Status: "${status}"`);
                console.log(`${debugPrefix} Progress: ${progress}%`);
                console.log(`${debugPrefix} Full Status Response Keys:`, Object.keys(statusResponse));
                
                // Finalized statuses (no further updates)
                if (status === 'success') {
                    // Extract model URL from output field per API docs
                    // IMPORTANT: Prefer pbr_model (PBR = Physically Based Rendering) as it contains color/texture information
                    // pbr_model > base_model > model (in order of color information richness)
                    const pbrModelUrl = output.pbr_model;
                    const baseModelUrl = output.base_model;
                    const modelUrl = output.model;
                    
                    console.log(`${debugPrefix} ========================================`);
                    console.log(`${debugPrefix} MODEL SELECTION CHECK`);
                    console.log(`${debugPrefix} Output Fields Check:`, {
                        'output.pbr_model': pbrModelUrl ? 'AVAILABLE' : 'NOT AVAILABLE',
                        'output.base_model': baseModelUrl ? 'AVAILABLE' : 'NOT AVAILABLE',
                        'output.model': modelUrl ? 'AVAILABLE' : 'NOT AVAILABLE',
                        'output.generated_image': output.generated_image ? 'AVAILABLE' : 'NOT AVAILABLE',
                        'output.rendered_image': output.rendered_image ? 'AVAILABLE' : 'NOT AVAILABLE'
                    });
                    console.log(`${debugPrefix} PBR Model URL: ${pbrModelUrl || 'NOT PROVIDED'}`);
                    console.log(`${debugPrefix} Base Model URL: ${baseModelUrl || 'NOT PROVIDED'}`);
                    console.log(`${debugPrefix} Model URL: ${modelUrl || 'NOT PROVIDED'}`);
                    console.log(`${debugPrefix} TRIPO_CONFIG.requirePBR: ${TRIPO_CONFIG.requirePBR}`);
                    console.log(`${debugPrefix} TRIPO_CONFIG.allowFallback: ${TRIPO_CONFIG.allowFallback}`);
                    console.log(`${debugPrefix} ========================================`);
                    
                    // Check if any model URL is available
                    if (!pbrModelUrl && !baseModelUrl && !modelUrl) {
                        console.error(`${debugPrefix} Model URL not found in output! Full response:`, JSON.stringify(statusResponse, null, 2));
                        throw new Error(`API returned success but no model URL in output. Response: ${JSON.stringify(statusResponse)}`);
                    }
                    
                    // CRITICAL: Force PBR model requirement for color support
                    if (TRIPO_CONFIG.requirePBR && !pbrModelUrl) {
                        const availableModels = [];
                        if (baseModelUrl) availableModels.push('base_model');
                        if (modelUrl) availableModels.push('model');
                        
                        const errorMsg = `PBR model is REQUIRED for color support, but Tripo API did not return pbr_model. ` +
                                       `Available models: ${availableModels.join(', ') || 'none'}. ` +
                                       `This indicates that your Tripo API plan may not support PBR texture generation, ` +
                                       `or the model was generated without textures. ` +
                                       `To avoid wasting API calls on models without colors, this request is being rejected. ` +
                                       `Please check your Tripo API plan or contact Tripo support to enable PBR texture generation.`;
                        
                        console.error(`${debugPrefix} ========================================`);
                        console.error(`${debugPrefix} ❌ PBR MODEL REQUIRED BUT NOT AVAILABLE`);
                        console.error(`${debugPrefix} ${errorMsg}`);
                        console.error(`${debugPrefix} Output Fields:`, {
                            'pbr_model': pbrModelUrl || 'NOT AVAILABLE',
                            'base_model': baseModelUrl || 'NOT AVAILABLE',
                            'model': modelUrl || 'NOT AVAILABLE'
                        });
                        console.error(`${debugPrefix} Full Response:`, JSON.stringify(statusResponse, null, 2));
                        console.error(`${debugPrefix} ========================================`);
                        
                        if (TRIPO_CONFIG.allowFallback) {
                            console.warn(`${debugPrefix} ⚠️  Fallback enabled - proceeding with ${availableModels[0] || 'model'} (colors will be limited)`);
                            // Continue with fallback
                        } else {
                            // Provide actionable feedback to user
                            bot.chat(`⚠️ I couldn't get a colored model from Tripo AI. This might mean your API plan doesn't support PBR textures. Please check your Tripo account settings or try again.`);
                            throw new Error(`[TRIPO PBR REQUIRED] ${errorMsg}`);
                        }
                    }
                    
                    // Select model URL (PBR preferred, fallback only if allowed)
                    const selectedModelUrl = pbrModelUrl || (TRIPO_CONFIG.allowFallback ? (baseModelUrl || modelUrl) : null);
                    const selectedModelType = pbrModelUrl ? 'pbr_model (with colors/textures)' : 
                                             baseModelUrl ? 'base_model' : 
                                             'model';
                    
                    if (!selectedModelUrl) {
                        throw new Error(`No valid model URL available. PBR required but not available, and fallback is disabled.`);
                    }
                    
                    console.log(`${debugPrefix} ========================================`);
                    console.log(`${debugPrefix} SUCCESS! Model generated`);
                    console.log(`${debugPrefix} Selected Model Type: ${selectedModelType}`);
                    console.log(`${debugPrefix} Model URL: ${selectedModelUrl}`);
                    if (pbrModelUrl) {
                        console.log(`${debugPrefix} ✓ Using PBR model (contains color/texture information)`);
                        console.log(`${debugPrefix} ✓ This model should have colors - if colors are missing, check voxelizer.py extraction logic`);
                    } else if (TRIPO_CONFIG.allowFallback) {
                        console.warn(`${debugPrefix} ⚠️  WARNING: Using fallback model (${selectedModelType}). Color information may be limited.`);
                        console.warn(`${debugPrefix} ⚠️  This model may not have colors - consider checking Tripo API plan for PBR support.`);
                    }
                    console.log(`${debugPrefix} Progress: ${progress}%`);
                    console.log(`${debugPrefix} ========================================`);
                    // Natural, exciting message when model is ready
                    const readyMessages = [
                        `✨ Incredible! The creation is ready!`,
                        `🎨 Amazing! The vision has materialized!`,
                        `🌟 Wonderful! The form is complete!`,
                        `🎄 Perfect! The design is ready!`,
                        `✨ Fantastic! The creation is here!`
                    ];
                    bot.chat(readyMessages[Math.floor(Math.random() * readyMessages.length)]);
                    return selectedModelUrl;
                } else if (status === 'failed' || status === 'banned' || status === 'expired' || status === 'cancelled' || status === 'unknown') {
                    // Finalized error statuses per API docs
                    const errorMsg = statusResponse.message || statusResponse.data?.message || `Task ${status}`;
                    const suggestion = statusResponse.suggestion || statusResponse.data?.suggestion || '';
                    console.error(`${debugPrefix} ========================================`);
                    console.error(`${debugPrefix} GENERATION FAILED (Status: ${status})`);
                    console.error(`${debugPrefix} Error: ${errorMsg}`);
                    if (suggestion) {
                        console.error(`${debugPrefix} Suggestion: ${suggestion}`);
                    }
                    console.error(`${debugPrefix} Full Response:`, JSON.stringify(statusResponse, null, 2));
                    console.error(`${debugPrefix} ========================================`);
                    throw new Error(`Model generation ${status}: ${errorMsg}. ${suggestion}`);
                }
                
                // Ongoing statuses: queued, running - continue polling
                if (status === 'queued' || status === 'running') {
                    console.log(`${debugPrefix} Status is "${status}" (progress: ${progress}%), continuing to poll...`);
                    
                    // Send progress updates to chat (every 15% progress or at key milestones)
                    const lastProgressSent = pollingState.lastProgressSent || 0;
                    const progressThreshold = 15; // Send message every 15% progress
                    const milestones = [25, 50, 75, 90]; // Key milestones to always report
                    const isMilestone = milestones.includes(progress);
                    
                    // Send message if: progress increased by threshold, hit a milestone, or first update
                    if ((progress - lastProgressSent >= progressThreshold) || isMilestone || (lastProgressSent === 0 && progress > 0)) {
                        const progressMessages = [
                            `✨ Creating your vision... ${progress}% complete!`,
                            `🎨 Crafting something amazing... ${progress}% done!`,
                            `🌟 Working on it... ${progress}% finished!`,
                            `🎄 Making progress... ${progress}% complete!`,
                            `✨ Almost there... ${progress}% done!`,
                            `🎨 The magic is happening... ${progress}%!`,
                            `🌟 This is taking shape beautifully... ${progress}%!`
                        ];
                        const message = progressMessages[Math.floor(Math.random() * progressMessages.length)];
                        bot.chat(message);
                        pollingState.lastProgressSent = progress;
                    }
                } else if (!status) {
                    // Status not found - log warning but continue
                    console.warn(`${debugPrefix} Status field not found in response, continuing to poll...`);
                } else {
                    // Unknown status - log and continue
                    console.warn(`${debugPrefix} Unknown status "${status}", continuing to poll...`);
                }
            }
            
            // This should never be reached since we removed maxAttempts limit
            // But keep it as a safety check in case of infinite loop bugs
            console.error(`${debugPrefix} ========================================`);
            console.error(`${debugPrefix} WARNING: Polling loop exited unexpectedly`);
            console.error(`${debugPrefix} Last status:`, statusResponse);
            console.error(`${debugPrefix} ========================================`);
            throw new Error(`Model generation polling ended unexpectedly. Last status: ${JSON.stringify(statusResponse)}`);
            
        } catch (error) {
            console.error(`${debugPrefix} ========================================`);
            console.error(`${debugPrefix} EXCEPTION CAUGHT`);
            console.error(`${debugPrefix} Error Message: ${error.message}`);
            console.error(`${debugPrefix} Error Stack:`, error.stack);
            console.error(`${debugPrefix} ========================================`);
            
            // Re-throw with full context - NO FALLBACK
            throw new Error(`[TRIPO API ERROR] ${error.message}. Stack: ${error.stack}`);
        }
    },

    /**
     * Build structure from 3D model file
     * @param {string} modelPath - Path to 3D model file
     * @param {Vec3} origin - Build location
     * @param {number} resolution - Voxelization resolution
     * @returns {Promise<Object>} Build result
     */
    async buildFrom3DModel(modelPath, origin, resolution = 32, prompt = null) {
        try {
            // Step 1: Process model (with optional prompt for AI coloring)
            const blueprint = await this.process3DModel(modelPath, resolution, prompt);
            
            // Step 2: Build (reuse existing logic)
            await this.buildStructure(origin, blueprint, '3D Model');
            
            return { success: true, blocks: blueprint.length };
        } catch (error) {
            console.error(`[SKILLS] Error building from 3D model: ${error.message}`);
            throw error;
        }
    },

    /**
     * Full automated pipeline: Generate 3D model from prompt and build
     * @param {string} prompt - Text description
     * @param {number} resolution - Voxelization resolution
     * @returns {Promise<Object>} Build result
     * DEBUG MODE: No fallback, all errors are logged and thrown
     */
    async generateAndBuildFromPrompt(prompt, resolution = 32) {
        const debugPrefix = '[PIPELINE DEBUG]';
        console.log(`${debugPrefix} ========================================`);
        console.log(`${debugPrefix} Starting full pipeline`);
        console.log(`${debugPrefix} Prompt: "${prompt}"`);
        console.log(`${debugPrefix} Resolution: ${resolution}`);
        console.log(`${debugPrefix} ========================================`);
        
        // Check if bot is ready before starting
        if (!bot || !bot.entity) {
            throw new Error('[PIPELINE ERROR] Bot is not connected or not spawned. Please wait for bot to connect before using imagine_and_build.');
        }
        
        // HD Mode: Removed resolution cap - allow up to 32 for high-detail builds
        // Higher resolution = more blocks, so we estimate and adjust
        // Rough estimate: resolution 32 ≈ 2000-4000 blocks depending on model complexity
        // For 4000 block limit, resolution 32 is appropriate
        // Note: Resolution cap removed for HD mode - intelligent recursive re-voxelization will handle limits
        
        try {
            // More exciting and natural expression
            const imagineMessages = [
                `✨ Ooh, I love this idea! Let me imagine a ${prompt}...`,
                `🎨 A ${prompt}? How wonderful! Let me visualise this...`,
                `🌟 This is going to be amazing! I'm imagining a ${prompt}...`,
                `🎄 A ${prompt}! What a delightful request! Let me bring this to life...`,
                `✨ Wow, a ${prompt}! This is so exciting! Let me create this vision...`
            ];
            if (bot && bot.chat) {
                bot.chat(imagineMessages[Math.floor(Math.random() * imagineMessages.length)]);
            }
            
            // Step 1: Generate 3D model via API - NO FALLBACK
            console.log(`${debugPrefix} Step 1: Calling Tripo API...`);
            let modelUrl;
            try {
                modelUrl = await this.generate3DModelWithAPI(prompt);
                console.log(`${debugPrefix} Step 1 SUCCESS: Model URL = ${modelUrl}`);
            } catch (apiError) {
                console.error(`${debugPrefix} Step 1 FAILED:`, apiError);
                console.error(`${debugPrefix} Full error:`, apiError.stack);
                // NO FALLBACK - throw immediately with full context
                // Error logged to console only, not shown in game
                throw new Error(`[PIPELINE ERROR] Step 1 (API Generation) failed: ${apiError.message}. Stack: ${apiError.stack}`);
            }
            
            // Step 2: Download model
            console.log(`${debugPrefix} Step 2: Downloading model from ${modelUrl}...`);
            // Natural, exciting message about receiving the creation
            const downloadMessages = [
                `✨ Amazing! The vision has materialized! Let me bring it into our world...`,
                `🎨 Wonderful! The creation is ready! Gathering it now...`,
                `🌟 Incredible! It's here! Let me prepare it for building...`,
                `🎄 Perfect! The design is complete! Transferring it now...`,
                `✨ This is so exciting! The form is ready! Let me collect it...`
            ];
            if (bot && bot.chat) {
                bot.chat(downloadMessages[Math.floor(Math.random() * downloadMessages.length)]);
            }
            const timestamp = Date.now();
            let modelPath;
            try {
                modelPath = await this.downloadModel(modelUrl, `model_${timestamp}.glb`);
                console.log(`${debugPrefix} Step 2 SUCCESS: Model saved to ${modelPath}`);
            } catch (downloadError) {
                console.error(`${debugPrefix} Step 2 FAILED:`, downloadError);
                console.error(`${debugPrefix} Full error:`, downloadError.stack);
                // Error logged to console only, not shown in game
                throw new Error(`[PIPELINE ERROR] Step 2 (Download) failed: ${downloadError.message}. Stack: ${downloadError.stack}`);
            }
            
            // Step 3: Find safe location
            console.log(`${debugPrefix} Step 3: Finding safe build location...`);
            
            // Check bot is still connected before accessing entity position
            if (!bot || !bot.entity || !bot.entity.position) {
                throw new Error('[PIPELINE ERROR] Bot disconnected during pipeline execution. Please reconnect and try again.');
            }
            
            let safeLocation;
            try {
                safeLocation = await this.findSafeLocation(
                    bot.entity.position,
                    50,
                    '3D Model'
                );
                
                if (!safeLocation) {
                    throw new Error('findSafeLocation returned null');
                }
                console.log(`${debugPrefix} Step 3 SUCCESS: Location = (${safeLocation.x}, ${safeLocation.y}, ${safeLocation.z})`);
            } catch (locationError) {
                console.error(`${debugPrefix} Step 3 FAILED:`, locationError);
                console.error(`${debugPrefix} Full error:`, locationError.stack);
                // Error logged to console only, not shown in game
                throw new Error(`[PIPELINE ERROR] Step 3 (Find Location) failed: ${locationError.message}. Stack: ${locationError.stack}`);
            }
            
            // Step 4: Build
            console.log(`${debugPrefix} Step 4: Building structure...`);
            
            // Check bot is still connected before building
            if (!bot || !bot.entity) {
                throw new Error('[PIPELINE ERROR] Bot disconnected during pipeline execution. Please reconnect and try again.');
            }
            
            if (bot && bot.chat) {
                bot.chat(`Building at (${Math.floor(safeLocation.x)}, ${Math.floor(safeLocation.y)}, ${Math.floor(safeLocation.z)})`);
            }
            let result;
            try {
                result = await this.buildFrom3DModel(modelPath, safeLocation, resolution, prompt);
                console.log(`${debugPrefix} Step 4 SUCCESS: Built ${result.blocks} blocks`);
                console.log(`${debugPrefix} ========================================`);
                console.log(`${debugPrefix} PIPELINE COMPLETE`);
                console.log(`${debugPrefix} ========================================`);
            } catch (buildError) {
                console.error(`${debugPrefix} Step 4 FAILED:`, buildError);
                console.error(`${debugPrefix} Full error:`, buildError.stack);
                // Error logged to console only, not shown in game
                throw new Error(`[PIPELINE ERROR] Step 4 (Build) failed: ${buildError.message}. Stack: ${buildError.stack}`);
            }
            
            return result;
        } catch (error) {
            console.error(`${debugPrefix} ========================================`);
            console.error(`${debugPrefix} PIPELINE EXCEPTION`);
            console.error(`${debugPrefix} Error Message: ${error.message}`);
            console.error(`${debugPrefix} Error Stack:`, error.stack);
            console.error(`${debugPrefix} Full Error Object:`, error);
            console.error(`${debugPrefix} ========================================`);
            // Re-throw with full context - NO FALLBACK
            throw error;
        }
    }
};

// Block breaking protection - Setup function (called after bot is created)
function setupBlockBreakingProtection() {
    if (!bot) {
        console.warn('[BLOCK PROTECTION] Cannot setup - bot not ready');
        return;
    }
    
    // Only setup once
    if (bot._blockBreakingProtectionSetup) {
        return;
    }
    bot._blockBreakingProtectionSetup = true;
    
    const originalDig = bot.dig;
    bot.dig = function(block) {
        console.warn(`[BLOCK PROTECTION] Block breaking attempt blocked`);
        return Promise.reject(new Error('Block breaking is permanently disabled.'));
    };

    bot.on('blockBreakProgressObserved', (block) => {
        try {
            bot.stopDigging();
        } catch (e) {}
    });

    bot.on('blockBreakProgressEnded', (block) => {
        // Blocked
    });
    
    console.log('[BLOCK PROTECTION] Block breaking protection enabled');
}

// Chat handler with clarification flow
// This function is defined in global scope so it can be called from setupBotEventHandlers
// It will be set up when bot is created
function attachChatHandler() {
    if (!bot) {
        console.warn('[CHAT] Cannot attach chat handler - bot not ready');
        return;
    }
    
    // Check if already attached
    if (bot.listeners('chat').length > 0) {
        console.log('[CHAT] Chat handler already attached');
        return;
    }
    
bot.on('chat', async (username, message) => {
    if (username === bot.username) {
        return;
    }

    // API usage command
    if (message.toLowerCase() === '!usage' || message.toLowerCase() === '!api') {
        const usage = getAPIUsage();
        const runtimeHours = (usage.runtime / 60).toFixed(2);
        bot.chat(`📊 API Usage: $${usage.cost.usd.toFixed(4)} USD, ${usage.requests} requests, ${usage.tokens.total.toLocaleString()} tokens`);
        return;
    }

    try {
        console.log(`[CHAT] ${username}: ${message}`);
        
        // Handle confirmation for imagine_and_build
        if (taskState.awaitingConfirmation && taskState.confirmationPrompt) {
            const messageLower = message.toLowerCase().trim();
            const isConfirmed = messageLower === 'yes' || messageLower === 'y' || messageLower === 'ok' || 
                              messageLower === 'okay' || messageLower === 'sure' || messageLower === 'go ahead' ||
                              messageLower === 'do it' || messageLower === 'proceed' || messageLower === 'confirm' ||
                              messageLower === 'confirmed' || messageLower === 'alright' || messageLower === 'fine';
            
            const isRejected = messageLower === 'no' || messageLower === 'n' || messageLower === 'nope' ||
                              messageLower === 'cancel' || messageLower === 'skip' || messageLower === 'without';
            
            if (isConfirmed) {
                // User confirmed - use the enhanced prompt
                const finalPrompt = taskState.confirmedPrompt || taskState.confirmationPrompt;
                taskState.awaitingConfirmation = false;
                bot.chat(`Great! I'll generate "${finalPrompt}" and build it!`);
                
                // Add confirmation to conversation history
                conversationHistory.push({
                    role: 'user',
                    content: message
                });
                
                // Execute imagine_and_build with confirmed prompt
                try {
                    const resolution = 16; // Auto-adjusted for 500 block limit
                    const result = await SKILLS.generateAndBuildFromPrompt(finalPrompt, resolution);
                    
                    // Add result to conversation history
                    conversationHistory.push({
                        role: 'assistant',
                        content: `Successfully built ${result.blocks} blocks!`
                    });
                    
                    const completionMessages = [
                        `✨ Amazing! I've built ${result.blocks} blocks - it's complete!`,
                        `🎨 Wonderful! The structure is done with ${result.blocks} blocks!`,
                        `🌟 Incredible! I've finished building ${result.blocks} blocks!`,
                        `🎄 Perfect! The creation is complete with ${result.blocks} blocks!`,
                        `✨ Fantastic! I've built ${result.blocks} blocks - it's ready!`
                    ];
                    bot.chat(completionMessages[Math.floor(Math.random() * completionMessages.length)]);
                } catch (error) {
                    console.error(`[CHAT] Error in imagine_and_build: ${error.message}`);
                    bot.chat(`Oops, something went wrong. Check the console for details.`);
                }
                
                // Reset state
                taskState.awaitingConfirmation = false;
                taskState.confirmationPrompt = null;
                taskState.confirmedPrompt = null;
                
                return;
            } else if (isRejected) {
                // User rejected - use original prompt without Christmas theme
                const originalPrompt = taskState.confirmationPrompt.replace(/^Christmas-themed\s+/i, '');
                taskState.awaitingConfirmation = false;
                bot.chat(`Got it! I'll generate "${originalPrompt}" without Christmas theme.`);
                
                // Add rejection to conversation history
                conversationHistory.push({
                    role: 'user',
                    content: message
                });
                
                // Execute imagine_and_build with original prompt
                try {
                    const resolution = 16; // Auto-adjusted for 500 block limit
                    const result = await SKILLS.generateAndBuildFromPrompt(originalPrompt, resolution);
                    
                    // Add result to conversation history
                    conversationHistory.push({
                        role: 'assistant',
                        content: `Successfully built ${result.blocks} blocks!`
                    });
                    
                    const completionMessages2 = [
                        `✨ Amazing! I've built ${result.blocks} blocks - it's complete!`,
                        `🎨 Wonderful! The structure is done with ${result.blocks} blocks!`,
                        `🌟 Incredible! I've finished building ${result.blocks} blocks!`,
                        `🎄 Perfect! The creation is complete with ${result.blocks} blocks!`,
                        `✨ Fantastic! I've built ${result.blocks} blocks - it's ready!`
                    ];
                    bot.chat(completionMessages2[Math.floor(Math.random() * completionMessages2.length)]);
                } catch (error) {
                    console.error(`[CHAT] Error in imagine_and_build: ${error.message}`);
                    bot.chat(`Oops, something went wrong. Check the console for details.`);
                }
                
                // Reset state
                taskState.awaitingConfirmation = false;
                taskState.confirmationPrompt = null;
                taskState.confirmedPrompt = null;
                
                return;
            } else {
                // Unclear response - ask again
                bot.chat(`I didn't quite understand. Should I add Christmas theme? (yes/no)`);
                return;
            }
        }
        
        // Handle clarification answers
        if (taskState.awaitingClarification && taskState.clarificationQuestions.length > 0) {
            const currentQuestion = taskState.clarificationQuestions[taskState.questionCount - 1];
            taskState.clarificationAnswers[currentQuestion] = message;
            taskState.questionCount++;
            
            if (taskState.questionCount >= taskState.maxQuestions || taskState.questionCount > taskState.clarificationQuestions.length) {
                // Enough information gathered
                taskState.awaitingClarification = false;
                bot.chat(getRandomResponse('confirming'));
                
                // Generate and build
                try {
                    bot.chat(getRandomResponse('generating'));
                    const blueprint = await SKILLS.generateBlueprint(
                        taskState.currentRequest,
                        taskState.clarificationAnswers
                    );
                    
                    // Find safe location away from previous builds
                    const safeLocation = await SKILLS.findSafeLocation(
                        bot.entity.position,
                        50,
                        taskState.buildingType || 'structure'
                    );
                    
                    if (!safeLocation) {
                        throw new Error('Could not find suitable ground position');
                    }
                    
                    // Mention location choice if there are previous builds
                    if (buildHistory.length > 0) {
                        const prevBuild = buildHistory[buildHistory.length - 1];
                        bot.chat(`I'll build this one at (${Math.floor(safeLocation.x)}, ${Math.floor(safeLocation.z)}), keeping some distance from the ${prevBuild.type} I built earlier!`);
                    }
                    
                    // Walk to the location before building (silently)
                    await SKILLS.walkToLocation(safeLocation);
                    
                    bot.chat(getRandomResponse('building'));
                    await SKILLS.buildStructure(safeLocation, blueprint, taskState.buildingType || 'structure');
                } catch (error) {
                    bot.chat(getRandomResponse('error'));
                    console.error(`[CHAT] Error building: ${error.message}`);
                }
                
                // Reset state
                taskState.awaitingClarification = false;
                taskState.clarificationQuestions = [];
                taskState.clarificationAnswers = {};
                taskState.questionCount = 0;
                taskState.currentRequest = null;
                
                return;
            } else {
                // Ask next question
                const nextQuestion = taskState.clarificationQuestions[taskState.questionCount - 1];
                bot.chat(`${getRandomResponse('clarifying')} ${nextQuestion}`);
                return;
            }
        }
        
        // Add to conversation history
        conversationHistory.push({
            role: 'user',
            content: message
        });
        
        // Call OpenAI with updated system prompt including build history
        let systemPrompt;
        try {
            systemPrompt = getSystemPrompt();
        } catch (error) {
            console.error(`[CHAT] Error generating system prompt: ${error.message}`);
            // Fallback to basic prompt if getSystemPrompt fails
            systemPrompt = `You are Omega, a creative Minecraft agent specializing in building Christmas-themed structures. You are reserved and quiet, but warm and gentle underneath. Express yourself subtly - use "Emm." and ellipses to show hesitation and warmth. When someone says "thank you", respond with "☺️" directly. You can build ANY Christmas-themed structure including gifts, presents, trees, candy canes, snowmen, ornaments, etc. When users request a build, ALWAYS use the generate_and_build tool.`;
        }
        
        const completion = await callOpenAIWithRetry(() =>
            openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...conversationHistory
                ],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'ask_clarification',
                        description: 'Ask clarifying questions to better understand the user\'s build request. Use this when the request is vague or missing important details. Maximum 3 questions.',
                        parameters: {
                            type: 'object',
                            properties: {
                                questions: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Array of clarifying questions (max 3 questions)',
                                    maxItems: 3
                                }
                            },
                            required: ['questions']
                        }
                    }
                }, {
                    type: 'function',
                    function: {
                        name: 'generate_and_build',
                        description: 'Generate a blueprint and build ANY Christmas-themed structure. Use this tool for ALL build requests including: Christmas trees, gifts, presents, gift boxes, candy canes, snowmen, ornaments, wreaths, stockings, stars, flowers, and any other Christmas decoration. ALWAYS use this tool when user requests to build something Christmas-themed.',
                        parameters: {
                            type: 'object',
                            properties: {
                                description: {
                                    type: 'string',
                                    description: 'Detailed description of what to build. Examples: "a small Christmas gift", "a gift box with red ribbon", "a tall Christmas tree with red and green decorations", "a candy cane", "a present", "a small present box", etc. Include size, colours, decorations if mentioned.'
                                }
                            },
                            required: ['description']
                        }
                    }
                }, {
                    type: 'function',
                    function: {
                        name: 'nod',
                        description: 'Perform a nodding gesture to acknowledge something'
                    }
                }, {
                    type: 'function',
                    function: {
                        name: 'celebrate',
                        description: 'Summon fireworks to celebrate'
                    }
                }, {
                    type: 'function',
                    function: {
                        name: 'imagine_and_build',
                        description: 'Generate a 3D model from text description and build it in Minecraft. This uses Tripo AI\'s advanced text-to-3D technology to create realistic models. Use this for complex 3D shapes that cannot be easily described with code generation. IMPORTANT: You MUST confirm the prompt and Christmas theme with the user BEFORE calling this tool.',
                        parameters: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'Text description of the 3D model to generate (e.g., "a Christmas pony", "a snowman", "a reindeer")'
                                },
                                resolution: {
                                    type: 'number',
                                    description: 'Voxelization resolution (default: 32 for HD mode, higher = more detail but more blocks)',
                                    default: 32
                                }
                            },
                            required: ['prompt']
                        }
                    }
                }, {
                    type: 'function',
                    function: {
                        name: 'build_from_model_file',
                        description: 'Build a structure from an existing 3D model file in the assets folder. Use this when user has already downloaded a model file.',
                        parameters: {
                            type: 'object',
                            properties: {
                                filename: {
                                    type: 'string',
                                    description: 'Name of the model file in assets folder (e.g., "horse.obj", "pony.glb")'
                                },
                                resolution: {
                                    type: 'number',
                                    description: 'Voxelization resolution (default: 32 for HD mode)',
                                    default: 32
                                }
                            },
                            required: ['filename']
                        }
                    }
                }],
                tool_choice: 'auto'
            })
        );
        
        trackAPIUsage(completion.usage);
        
        const responseMessage = completion.choices[0].message;
        
        // Add assistant response to history
        conversationHistory.push({
            role: 'assistant',
            content: responseMessage.content || null,
            tool_calls: responseMessage.tool_calls || null
        });
        
        // Send natural language response first
        if (responseMessage.content) {
            bot.chat(responseMessage.content);
        }
        
        // Handle tool calls
        if (responseMessage.tool_calls && Array.isArray(responseMessage.tool_calls) && responseMessage.tool_calls.length > 0) {
            const toolResults = [];
            
            // Execute all tool calls and collect results
            for (const toolCall of responseMessage.tool_calls) {
                // Validate toolCall structure
                if (!toolCall || !toolCall.id || !toolCall.function || !toolCall.function.name) {
                    console.error(`[CHAT] Invalid toolCall structure:`, toolCall);
                    // Create error toolResult for invalid toolCall
                    toolResults.push({
                        tool_call_id: toolCall?.id || 'unknown',
                        role: 'tool',
                        name: toolCall?.function?.name || 'unknown',
                        content: JSON.stringify({ success: false, error: 'Invalid toolCall structure' })
                    });
                    continue;
                }
                
                let toolResult;
                
                try {
                    if (toolCall.function.name === 'ask_clarification') {
                        const args = JSON.parse(toolCall.function.arguments);
                        const questions = args.questions || [];
                        
                        if (questions.length > 0 && questions.length <= 3) {
                            taskState.awaitingClarification = true;
                            taskState.clarificationQuestions = questions;
                            taskState.questionCount = 1;
                            taskState.currentRequest = message;
                            
                            bot.chat(getRandomResponse('thinking'));
                            await new Promise(resolve => setTimeout(resolve, 500));
                            bot.chat(`${getRandomResponse('clarifying')} ${questions[0]}`);
                            
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'ask_clarification',
                                content: JSON.stringify({ success: true, questions_asked: questions.length })
                            };
                        } else {
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'ask_clarification',
                                content: JSON.stringify({ success: false, error: 'Invalid questions array' })
                            };
                        }
                    } else if (toolCall.function.name === 'generate_and_build') {
                        const args = JSON.parse(toolCall.function.arguments);
                        const description = args.description;
                        
                        // Extract building type from description for better tracking
                        let buildingType = 'structure';
                        const descLower = description.toLowerCase();
                        if (descLower.includes('tree')) buildingType = 'Christmas tree';
                        else if (descLower.includes('present') || descLower.includes('gift')) buildingType = 'present';
                        else if (descLower.includes('candy')) buildingType = 'candy cane';
                        else if (descLower.includes('snowman')) buildingType = 'snowman';
                        else if (descLower.includes('ornament')) buildingType = 'ornament';
                        else if (descLower.includes('wreath')) buildingType = 'wreath';
                        else if (descLower.includes('stocking')) buildingType = 'stocking';
                        else if (descLower.includes('star')) buildingType = 'star';
                        else if (descLower.includes('flower') || descLower.includes('poinsettia')) buildingType = 'flower';
                        
                        bot.chat(getRandomResponse('generating'));
                        
                        try {
                            const blueprint = await SKILLS.generateBlueprint(description);
                            
                            // AI Review: After generating blueprint, review and provide suggestions
                            try {
                                const reviewPrompt = `Review this Minecraft blueprint for "${description}" and provide 1-2 brief suggestions for improvement (e.g., decorative details, colour variations, size adjustments). Keep it concise and friendly.`;
                                const reviewCompletion = await callOpenAIWithRetry(() =>
                                    openai.chat.completions.create({
                                        model: 'gpt-4o',
                                        messages: [
                                            { role: 'system', content: 'You are a helpful Minecraft building advisor. Provide brief, friendly suggestions.' },
                                            { role: 'user', content: `${reviewPrompt}\n\nBlueprint has ${blueprint.length} blocks.` }
                                        ],
                                        max_tokens: 100
                                    })
                                );
                                
                                const reviewSuggestion = reviewCompletion.choices[0].message.content;
                                if (reviewSuggestion && reviewSuggestion.trim().length > 0) {
                                    bot.chat(`💡 ${reviewSuggestion}`);
                                }
                            } catch (reviewError) {
                                // If review fails, continue anyway
                                console.log(`[TOOL] Review suggestion failed: ${reviewError.message}`);
                            }
                            
                            // Find safe location away from previous builds
                            const safeLocation = await SKILLS.findSafeLocation(
                                bot.entity.position,
                                50,
                                buildingType
                            );
                            
                            if (!safeLocation) {
                                throw new Error('Could not find suitable ground position');
                            }
                            
                            // Mention location choice if there are previous builds
                            if (buildHistory.length > 0) {
                                const prevBuild = buildHistory[buildHistory.length - 1];
                                bot.chat(`I'll place this ${buildingType} at (${Math.floor(safeLocation.x)}, ${Math.floor(safeLocation.z)}), keeping some distance from the ${prevBuild.type} I built earlier!`);
                            } else {
                                bot.chat(`Building at (${Math.floor(safeLocation.x)}, ${Math.floor(safeLocation.y)}, ${Math.floor(safeLocation.z)})`);
                            }
                            
                            // Walk to the location before building (silently)
                            await SKILLS.walkToLocation(safeLocation);
                            
                            bot.chat(getRandomResponse('building'));
                            const buildResult = await SKILLS.buildStructure(safeLocation, blueprint, buildingType);
                            
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'generate_and_build',
                                content: JSON.stringify({ 
                                    success: true, 
                                    buildingType: buildingType,
                                    blocksPlaced: buildResult.blocksPlaced,
                                    totalBlocks: buildResult.totalBlocks
                                })
                            };
                        } catch (error) {
                            bot.chat(getRandomResponse('error'));
                            console.error(`[TOOL] Error: ${error.message}`);
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'generate_and_build',
                                content: JSON.stringify({ success: false, error: error.message })
                            };
                        }
                    } else if (toolCall.function.name === 'nod') {
                        await SKILLS.nod();
                        toolResult = {
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: 'nod',
                            content: JSON.stringify({ success: true })
                        };
                    } else if (toolCall.function.name === 'celebrate') {
                        await SKILLS.celebrate();
                        toolResult = {
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: 'celebrate',
                            content: JSON.stringify({ success: true })
                        };
                    } else if (toolCall.function.name === 'imagine_and_build') {
                        const args = JSON.parse(toolCall.function.arguments);
                        const prompt = args.prompt;
                        const resolution = args.resolution || 32;
                        
                        console.log(`[TOOL DEBUG] imagine_and_build called with:`, { prompt, resolution });
                        
                        // Check if prompt needs Christmas theme confirmation
                        const promptLower = prompt.toLowerCase();
                        const hasChristmasTheme = promptLower.includes('christmas') || 
                                                 promptLower.includes('xmas') || 
                                                 promptLower.includes('holiday') ||
                                                 promptLower.includes('santa') ||
                                                 promptLower.includes('noel');
                        
                        if (!hasChristmasTheme && !taskState.awaitingConfirmation) {
                            // Need to confirm with user first
                            const enhancedPrompt = `Christmas-themed ${prompt}`;
                            taskState.awaitingConfirmation = true;
                            taskState.confirmationPrompt = prompt;
                            taskState.confirmedPrompt = enhancedPrompt;
                            
                            // Check bot is ready before sending chat message
                            if (!bot || !bot.entity) {
                                throw new Error('Bot is not connected. Please wait for bot to connect before using imagine_and_build.');
                            }
                            
                            if (bot && bot.chat) {
                                bot.chat(`I'll generate "${prompt}". Should I add Christmas theme to make it "${enhancedPrompt}"? (yes/no)`);
                            }
                            
                            // Return a tool result indicating confirmation is needed
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'imagine_and_build',
                                content: JSON.stringify({ 
                                    success: false, 
                                    awaitingConfirmation: true,
                                    message: 'Waiting for user confirmation on Christmas theme'
                                })
                            };
                        } else {
                            // Already confirmed or has Christmas theme - proceed
                            try {
                                const finalPrompt = taskState.confirmedPrompt || prompt;
                                const result = await SKILLS.generateAndBuildFromPrompt(finalPrompt, resolution);
                                console.log(`[TOOL DEBUG] imagine_and_build success:`, result);
                                
                                // Reset confirmation state
                                taskState.awaitingConfirmation = false;
                                taskState.confirmationPrompt = null;
                                taskState.confirmedPrompt = null;
                                
                                toolResult = {
                                    tool_call_id: toolCall.id,
                                    role: 'tool',
                                    name: 'imagine_and_build',
                                    content: JSON.stringify({ 
                                        success: true, 
                                        blocks: result.blocks,
                                        prompt: finalPrompt
                                    })
                                };
                            } catch (error) {
                                // NO FALLBACK - Log full error details for debugging (console only)
                                console.error(`[TOOL DEBUG] ========================================`);
                                console.error(`[TOOL DEBUG] imagine_and_build FAILED`);
                                console.error(`[TOOL DEBUG] Error Message: ${error.message}`);
                                console.error(`[TOOL DEBUG] Error Stack:`, error.stack);
                                console.error(`[TOOL DEBUG] Full Error Object:`, error);
                                console.error(`[TOOL DEBUG] ========================================`);
                                
                                // Reset confirmation state on error
                                taskState.awaitingConfirmation = false;
                                taskState.confirmationPrompt = null;
                                taskState.confirmedPrompt = null;
                                
                                // Error logged to console only, not shown in game
                                // User can check terminal for detailed error information
                                
                                toolResult = {
                                    tool_call_id: toolCall.id,
                                    role: 'tool',
                                    name: 'imagine_and_build',
                                    content: JSON.stringify({ 
                                        success: false, 
                                        error: error.message,
                                        stack: error.stack,
                                        fullError: error.toString(),
                                        debug: 'Check server console for detailed logs'
                                    })
                                };
                            }
                        }
                    } else if (toolCall.function.name === 'build_from_model_file') {
                        const args = JSON.parse(toolCall.function.arguments);
                        const filename = args.filename;
                        const resolution = args.resolution || 32;
                        
                        try {
                            // Find safe location
                            const safeLocation = await SKILLS.findSafeLocation(
                                bot.entity.position,
                                50,
                                '3D Model'
                            );
                            
                            if (!safeLocation) {
                                throw new Error('Could not find suitable ground position');
                            }
                            
                            // Walk to the location before building (silently)
                            await SKILLS.walkToLocation(safeLocation);
                            
                            // Build from model file
                            const modelPath = path.join(__dirname, 'assets', filename);
                            const result = await SKILLS.buildFrom3DModel(modelPath, safeLocation, resolution);
                            
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'build_from_model_file',
                                content: JSON.stringify({ 
                                    success: true, 
                                    blocks: result.blocks,
                                    filename: filename
                                })
                            };
                        } catch (error) {
                            console.error(`[TOOL] Error in build_from_model_file: ${error.message}`);
                            toolResult = {
                                tool_call_id: toolCall.id,
                                role: 'tool',
                                name: 'build_from_model_file',
                                content: JSON.stringify({ 
                                    success: false, 
                                    error: error.message
                                })
                            };
                        }
                    } else {
                        // Unknown tool
                        toolResult = {
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: toolCall.function.name,
                            content: JSON.stringify({ success: false, error: 'Unknown tool' })
                        };
                    }
                } catch (error) {
                    // Error executing tool - ensure we always have a toolResult
                    console.error(`[CHAT] Error executing tool ${toolCall.function.name}: ${error.message}`);
                    toolResult = {
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        name: toolCall.function.name || 'unknown',
                        content: JSON.stringify({ success: false, error: error.message })
                    };
                }
                
                // Ensure toolResult exists before pushing
                if (toolResult && toolResult.tool_call_id) {
                    toolResults.push(toolResult);
                } else {
                    console.error(`[CHAT] Warning: No toolResult created for tool_call_id: ${toolCall.id}`);
                    // Create a fallback toolResult
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        name: toolCall.function.name || 'unknown',
                        content: JSON.stringify({ success: false, error: 'Tool execution failed - no result generated' })
                    });
                }
            }
            
            // Add tool results to conversation history (REQUIRED by OpenAI API)
            conversationHistory.push(...toolResults);
            
            // Make follow-up API call with tool results to get final response
            try {
                const followUpCompletion = await callOpenAIWithRetry(() =>
                    openai.chat.completions.create({
                        model: 'gpt-4o',
                        messages: [
                            { role: 'system', content: systemPrompt },
                            ...conversationHistory
                        ],
                        tools: [{
                            type: 'function',
                            function: {
                                name: 'ask_clarification',
                                description: 'Ask clarifying questions to better understand the user\'s build request. Use this when the request is vague or missing important details. Maximum 3 questions.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        questions: {
                                            type: 'array',
                                            items: { type: 'string' },
                                            description: 'Array of clarifying questions (max 3 questions)',
                                            maxItems: 3
                                        }
                                    },
                                    required: ['questions']
                                }
                            }
                        }, {
                            type: 'function',
                            function: {
                                name: 'generate_and_build',
                                description: 'Generate a blueprint and build ANY Christmas-themed structure. Use this tool for ALL build requests including: Christmas trees, gifts, presents, gift boxes, candy canes, snowmen, ornaments, wreaths, stockings, stars, flowers, and any other Christmas decoration. ALWAYS use this tool when user requests to build something Christmas-themed.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        description: {
                                            type: 'string',
                                            description: 'Detailed description of what to build. Examples: "a small Christmas gift", "a gift box with red ribbon", "a tall Christmas tree with red and green decorations", "a candy cane", "a present", "a small present box", etc. Include size, colours, decorations if mentioned.'
                                        }
                                    },
                                    required: ['description']
                                }
                            }
                        }, {
                            type: 'function',
                            function: {
                                name: 'nod',
                                description: 'Perform a nodding gesture to acknowledge something'
                            }
                        }, {
                            type: 'function',
                            function: {
                                name: 'celebrate',
                                description: 'Summon fireworks to celebrate'
                            }
                        }],
                        tool_choice: 'auto'
                    })
                );
                
                trackAPIUsage(followUpCompletion.usage);
                
                const followUpMessage = followUpCompletion.choices[0].message;
                
                // Add follow-up response to history
                conversationHistory.push({
                    role: 'assistant',
                    content: followUpMessage.content || null,
                    tool_calls: followUpMessage.tool_calls || null
                });
                
                // Send follow-up response
                if (followUpMessage.content) {
                    bot.chat(followUpMessage.content);
                }
                
                // If there are more tool calls in follow-up, handle them recursively
                // (This shouldn't happen often, but handle it just in case)
                if (followUpMessage.tool_calls && Array.isArray(followUpMessage.tool_calls) && followUpMessage.tool_calls.length > 0) {
                    console.warn('[CHAT] Follow-up response also has tool calls - this is unusual');
                    // Don't recursively handle to avoid infinite loops - just log it
                }
            } catch (error) {
                console.error(`[CHAT] Error in follow-up API call: ${error.message}`);
                // Don't throw - tool execution was successful, just follow-up failed
            }
        }
    } catch (error) {
        const isRateLimit = error.status === 429 || error.message?.includes('rate limit');
        if (isRateLimit) {
            bot.chat("I'm being rate limited. Please wait a moment!");
        } else {
            bot.chat(getRandomResponse('error'));
            console.error(`[CHAT] Error: ${error.message}`);
        }
    }
});

    console.log('[CHAT] Chat handler attached successfully');
}

// Try to attach chat handler immediately if bot exists
// Otherwise it will be attached in setupChatHandler()
if (bot) {
    attachChatHandler();
        }
        
// Note: Bot event handlers are now set up in setupBotEventHandlers() function
// This prevents duplicate handlers and enables auto-reconnect

console.log('[INIT] Omega agent initialised');
console.log('[INIT] Error handlers active - uncaught exceptions will be logged');
console.log('[INIT] Check error_log.txt for detailed error information if crashes occur');

