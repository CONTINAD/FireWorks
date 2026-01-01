const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bs58 = require('bs58');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIGURATION (Set via Railway Environment Variables)
// ==========================================
const HELIUS_RPC = process.env.HELIUS_RPC || 'https://mainnet.helius-rpc.com/?api-key=ae211108-bdbf-40af-90e2-c5418e3f62d3';
const TOKEN_CA = process.env.TOKEN_CA || 'G5TDFMyGsgJ4rWXxatzxZEcYJmVkTjG3mZTZMnbRpump';
const CREATOR_PRIVATE_KEY = process.env.CREATOR_PRIVATE_KEY || '';
const PUMPPORTAL_API = 'https://pumpportal.fun/api/trade-local';

console.log('🔧 Config loaded:');
console.log(`   HELIUS_RPC: ${HELIUS_RPC.substring(0, 50)}...`);
console.log(`   TOKEN_CA: ${TOKEN_CA}`);
console.log(`   CREATOR_PRIVATE_KEY: ${CREATOR_PRIVATE_KEY ? '✅ Set' : '❌ Not set'}`);

// ==========================================
// CLAIM CREATOR FEES FROM PUMPFUN (Local Signing)
// ==========================================
const { Keypair, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } = require('@solana/web3.js');

const connection = new Connection(HELIUS_RPC, 'confirmed');

// Create creator keypair from private key
let creatorKeypair = null;
if (CREATOR_PRIVATE_KEY) {
    try {
        creatorKeypair = Keypair.fromSecretKey(bs58.decode(CREATOR_PRIVATE_KEY));
        console.log(`✅ Creator wallet loaded: ${creatorKeypair.publicKey.toBase58().substring(0, 8)}...`);
    } catch (e) {
        console.log('❌ Failed to load creator keypair:', e.message);
    }
}

async function claimCreatorFees() {
    if (!creatorKeypair) {
        console.log('⚠️ No creator keypair loaded, skipping fee claim');
        return { success: false, amount: 0 };
    }

    try {
        console.log('💰 Claiming creator fees from PumpFun...');
        console.log('   Creator wallet:', creatorKeypair.publicKey.toBase58().substring(0, 8) + '...');

        // Step 1: Check balance BEFORE claim
        const balanceBefore = await connection.getBalance(creatorKeypair.publicKey);
        console.log(`   Balance before: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

        // Step 2: Get the unsigned transaction from PumpPortal
        const response = await fetch('https://pumpportal.fun/api/trade-local', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'collectCreatorFee',
                publicKey: creatorKeypair.publicKey.toBase58(),
                mint: TOKEN_CA,
                priorityFee: 0.0001
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log('⚠️ PumpPortal error:', response.status, errorText);
            return { success: false, amount: 0, error: errorText };
        }

        // Step 3: Get the transaction bytes
        const txData = await response.arrayBuffer();
        console.log('   Got transaction data, size:', txData.byteLength, 'bytes');

        if (txData.byteLength === 0) {
            console.log('⚠️ Empty transaction - no fees to claim');
            return { success: false, amount: 0, error: 'No fees to claim' };
        }

        // Step 4: Deserialize and sign the transaction
        const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
        tx.sign([creatorKeypair]);
        console.log('   Transaction signed');

        // Step 5: Broadcast the signed transaction
        const signature = await connection.sendTransaction(tx, {
            skipPreflight: true,
            maxRetries: 3
        });

        console.log(`✅ Fee claim TX sent: ${signature}`);

        // Step 6: Wait a moment for tx to process, then check balance AFTER
        await new Promise(r => setTimeout(r, 2000));
        const balanceAfter = await connection.getBalance(creatorKeypair.publicKey);
        console.log(`   Balance after: ${(balanceAfter / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

        // Step 7: Calculate the ACTUAL claimed amount (difference minus tx fee)
        const claimedLamports = balanceAfter - balanceBefore;
        const claimedSol = claimedLamports / LAMPORTS_PER_SOL;

        if (claimedSol > 0) {
            console.log(`   💵 Claimed: ${claimedSol.toFixed(4)} SOL`);
            return { success: true, amount: claimedSol, signature };
        } else {
            console.log('⚠️ No fees were claimed (balance unchanged or decreased)');
            return { success: false, amount: 0, error: 'No fees claimed' };
        }

    } catch (error) {
        console.log('❌ Fee claim failed:', error.message);
        return { success: false, amount: 0, error: error.message };
    }
}


// ==========================================
// MULTI-HOP FEE DISTRIBUTION (Avoid Bubble Map)
// ==========================================
// Uses connection and Solana imports from above

// Helper: delay between transfers
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: transfer SOL from one wallet to another
async function transferSol(fromKeypair, toPublicKey, lamports) {
    const { blockhash } = await connection.getLatestBlockhash();

    const transaction = new Transaction({
        recentBlockhash: blockhash,
        feePayer: fromKeypair.publicKey
    }).add(
        SystemProgram.transfer({
            fromPubkey: fromKeypair.publicKey,
            toPubkey: toPublicKey,
            lamports: lamports
        })
    );

    const signature = await connection.sendTransaction(transaction, [fromKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
}

// Main distribution function: Dev → Hot1 → Hot2 → Winner
async function distributeToWinner(winnerWalletAddress, claimedAmount) {
    if (!creatorKeypair || claimedAmount <= 0) {
        console.log('⚠️ No fees to distribute or no keypair');
        return { success: false };
    }

    try {
        // Use global creatorKeypair
        const winnerPubkey = new PublicKey(winnerWalletAddress);

        // Keep 10% - send 90% to winner
        const payoutAmount = claimedAmount * 0.9;
        const txFee = 0.000005; // ~5000 lamports per tx
        const totalNeeded = payoutAmount + (txFee * 3); // 3 transfers

        // Check creator balance
        const creatorBalance = await connection.getBalance(creatorKeypair.publicKey);
        const creatorBalanceSol = creatorBalance / LAMPORTS_PER_SOL;

        if (creatorBalanceSol < totalNeeded) {
            console.log(`⚠️ Insufficient balance: ${creatorBalanceSol} SOL < ${totalNeeded} SOL needed`);
            return { success: false, error: 'Insufficient balance' };
        }

        console.log(`💸 Distributing ${payoutAmount.toFixed(4)} SOL to winner (kept 10%)`);

        // Generate 2 temp hot wallets
        const hot1 = Keypair.generate();
        const hot2 = Keypair.generate();

        const payoutLamports = Math.floor(payoutAmount * LAMPORTS_PER_SOL);
        const transferWithFee = payoutLamports + 10000; // Extra for tx fees

        // Transfer 1: Creator → Hot1
        console.log('🔥 Transfer 1: Creator → Hot1');
        await transferSol(creatorKeypair, hot1.publicKey, transferWithFee);
        await delay(1000 + Math.random() * 2000); // 1-3 sec delay

        // Transfer 2: Hot1 → Hot2
        console.log('🔥 Transfer 2: Hot1 → Hot2');
        await transferSol(hot1, hot2.publicKey, payoutLamports + 5000);
        await delay(1000 + Math.random() * 2000);

        // Transfer 3: Hot2 → Winner
        console.log('🔥 Transfer 3: Hot2 → Winner');
        const finalSig = await transferSol(hot2, winnerPubkey, payoutLamports);

        console.log(`✅ Distribution complete! Final TX: ${finalSig}`);
        console.log(`   Winner: ${winnerWalletAddress}`);
        console.log(`   Amount: ${payoutAmount.toFixed(4)} SOL`);

        return { success: true, signature: finalSig, amount: payoutAmount };

    } catch (error) {
        console.log('❌ Distribution failed:', error.message);
        return { success: false, error: error.message };
    }
}

// ==========================================
// GAME CONFIGURATION
// ==========================================
const CONFIG = {
    ROUND_DURATION: 120, // 2 minute rounds
    MIN_FIREWORKS: 12,
    MAX_FIREWORKS: 18,
    TICK_RATE: 60,
    COLORS: [
        '#ff9500', '#ffd700', '#ff6b9d', '#9945FF',
        '#00d4ff', '#00ff88', '#ff4d4d', '#ffffff',
        '#ff3366', '#33ff99', '#6699ff', '#ffcc00'
    ]
};

// Real holder wallets (populated from Helius)
let realHolders = [];

// ==========================================
// FETCH TOKEN HOLDERS FROM HELIUS
// ==========================================
async function fetchTokenHolders() {
    try {
        console.log('📡 Fetching token holders from Helius...');

        const response = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenAccounts',
                params: {
                    mint: TOKEN_CA,
                    limit: 50
                }
            })
        });

        const data = await response.json();

        if (data.result && data.result.token_accounts) {
            realHolders = data.result.token_accounts.map(acc => ({
                wallet: acc.owner.substring(0, 8),
                fullWallet: acc.owner,
                balance: acc.amount
            }));
            console.log(`✅ Found ${realHolders.length} token holders`);
        } else {
            console.log('❌ No holders found from Helius');
            realHolders = [];
        }
    } catch (error) {
        console.log('❌ Helius fetch failed:', error.message);
        realHolders = [];
    }
}

// ==========================================
// PERSISTENT STATS (survives deploys)
// ==========================================
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const stats = JSON.parse(data);
            console.log(`📊 Loaded stats: Round ${stats.currentRound}, ${stats.totalDistributed} SOL distributed`);
            return stats;
        }
    } catch (error) {
        console.log('⚠️ Could not load stats:', error.message);
    }
    return null;
}

function saveStats() {
    try {
        const stats = {
            currentRound: gameState.currentRound,
            totalDistributed: gameState.totalDistributed,
            winners: gameState.winners.slice(0, 50) // Keep last 50 winners
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        console.log(`💾 Saved stats: Round ${stats.currentRound}`);
    } catch (error) {
        console.log('⚠️ Could not save stats:', error.message);
    }
}

// ==========================================
// GAME STATE
// ==========================================
const savedStats = loadStats();

let gameState = {
    currentRound: savedStats?.currentRound || 1,
    timeRemaining: CONFIG.ROUND_DURATION,
    prizePool: 0,
    totalDistributed: savedStats?.totalDistributed || 0,
    fireworks: [],
    winner: null,
    phase: 'racing',
    roundStartTime: Date.now(),
    winners: savedStats?.winners || [],
    cameraY: 0,
    lastClaimedAmount: 0,
    claimStatus: 'idle' // idle, claiming, claimed, failed
};

// ==========================================
// FIREWORK CLASS
// ==========================================
class ServerFirework {
    constructor(id, wallet, fullWallet, lane, totalLanes) {
        this.id = id;
        this.wallet = wallet;
        this.fullWallet = fullWallet; // Full wallet address for prize distribution
        this.lane = lane;
        this.totalLanes = totalLanes;

        // Position
        this.x = (lane + 0.5) / totalLanes;
        this.y = 1.0; // Start at bottom (1.0 = bottom, 0.0 = top)
        this.startY = 1.0;

        // Launch timing - Simultaneous start (tiny jitter for decoupling)
        this.launchDelay = Math.random() * 500;

        // Speed - SLOWER for 2 minute races, TIGHT variance for neck-and-neck
        this.baseSpeed = 0.00012 + Math.random() * 0.00006;
        this.speed = this.baseSpeed;

        // Drift - minimal so they stay close
        this.drift = (Math.random() - 0.5) * 0.0001;
        this.accel = 1.0008; // Very gentle acceleration

        // Visual
        this.color = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];
        this.secondaryColor = CONFIG.COLORS[Math.floor(Math.random() * CONFIG.COLORS.length)];

        // State
        this.hasExploded = false;
        this.heightReached = 0;

        // Predetermined explosion height (in METERS)
        // 70% chance to survive to high altitude for intense competition
        if (Math.random() > 0.3) {
            this.maxHeightMeters = 1800 + Math.random() * 1500; // CONTENDERS
        } else {
            this.maxHeightMeters = 300 + Math.random() * 1200; // EARLY EXITS
        }
    }

    update(elapsedTime) {
        if (this.hasExploded) return;

        // Wait for launch delay
        if (elapsedTime < this.launchDelay) return;

        // Move upward with slight acceleration
        this.y -= this.speed;
        this.speed *= this.accel; // Accelerate like a rocket

        // Cap max speed
        if (this.speed > 0.003) this.speed = 0.003;

        // Apply constant drift (wind/angle)
        this.x += this.drift;

        // Keep in bounds
        this.x = Math.max(0.05, Math.min(0.95, this.x));

        // Height reached (1.0 y = 0m. 0.0 y = 1000m. -1.0 y = 2000m)
        // Formula: (1.0 - y) * 1000
        this.heightReached = (this.startY - this.y) * 1000;

        // Explode if we passed our max height
        if (this.heightReached >= this.maxHeightMeters && this.maxHeightMeters < 2000) {
            this.explode();
        }
    }

    explode() {
        this.hasExploded = true;
    }

    toJSON() {
        return {
            id: this.id,
            wallet: this.wallet,
            x: this.x,
            y: this.y,
            color: this.color,
            secondaryColor: this.secondaryColor,
            hasExploded: this.hasExploded,
            heightReached: Math.floor(this.heightReached)
        };
    }
}

// ==========================================
// GAME LOGIC
// ==========================================
function startNewRound() {
    // Fees already claimed 5 seconds before during break phase

    // START THE ROUND
    gameState.timeRemaining = CONFIG.ROUND_DURATION;
    gameState.winner = null;
    gameState.phase = 'racing';
    gameState.roundStartTime = Date.now();
    gameState.fireworks = [];
    gameState.cameraY = 0;

    // REAL HOLDERS ONLY - no fakes
    if (realHolders.length === 0) {
        console.log('⚠️ No holders found - waiting for Helius data');
        return;
    }

    // Filter out LP wallets (Raydium, Meteora, etc.)
    const LP_WALLETS = [
        '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM
        'BVChZ3XFEwTMUk1o9i3HAf91H6mFxSwa5X2wFAWhYPhU', // Meteora
        // Add more LP wallets as needed
    ];

    // Minimum 300K tokens to be eligible (300,000 tokens)
    const MIN_TOKENS = 300000;

    const eligibleHolders = realHolders.filter(h => {
        // Exclude LP wallets
        if (LP_WALLETS.includes(h.fullWallet)) return false;
        // Must have at least 300k tokens
        const balance = parseInt(h.balance) || 0;
        return balance >= MIN_TOKENS;
    });

    console.log(`📊 ${realHolders.length} total holders, ${eligibleHolders.length} eligible (300K+ tokens, excluding LPs)`);

    // SCALABILITY: Cap at 50 fireworks per round
    const MAX_CONCURRENT = 50;
    let contenders = [...eligibleHolders];

    if (contenders.length > MAX_CONCURRENT) {
        // Shuffle and pick 50
        for (let i = contenders.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [contenders[i], contenders[j]] = [contenders[j], contenders[i]];
        }
        contenders = contenders.slice(0, MAX_CONCURRENT);
        console.log(`⚠️ Too many eligible. Selected 50 random contenders.`);
    }

    const count = contenders.length;

    for (let i = 0; i < count; i++) {
        const holder = contenders[i];
        gameState.fireworks.push(new ServerFirework(i, holder.wallet, holder.fullWallet, i, count));
    }

    console.log(`🎆 Round #${gameState.currentRound} started with ${count} fireworks, Prize: ${gameState.prizePool} SOL`);

    io.emit('newRound', getGameStateForClient());
}

function updateGame() {
    if (gameState.phase !== 'racing' && gameState.phase !== 'celebrating') return;

    const elapsedTime = Date.now() - gameState.roundStartTime;

    if (gameState.phase === 'racing') {
        // Update all fireworks
        gameState.fireworks.forEach(fw => fw.update(elapsedTime));

        // Update camera to follow the LEADER (highest firework)
        const active = gameState.fireworks.filter(fw => !fw.hasExploded);

        if (active.length > 0) {
            const minY = Math.min(...active.map(fw => fw.y));
            // Camera tracks leader. 1.0 - y is normal height.
            // If y goes negative, camera goes > 1.0.
            const targetHeight = 1.0 - minY;
            gameState.cameraY += (targetHeight - gameState.cameraY) * 0.12;
        }

        // Win Condition 1: FIRST TO 2000m (-1.0 y)
        const winner = active.find(fw => fw.heightReached >= 2000);
        if (winner && !gameState.winner) {
            startCelebration(winner);
        }

        // Win Condition 2: Last survivor (if no one reached 2000 yet and others died)
        if (active.length === 1 && !gameState.winner && gameState.fireworks.length > 1) {
            // Only declare if "Last Man Standing" logic is desired, 
            // BUT user said "keep going". So maybe we wait?
            // If the last guy is at 500m, should he win? 
            // User said "first one to 2k".
            // Let's let him fly solo until 2k? 
            // Or just trigger celebration which lets him fly.
            startCelebration(active[0]);
        }
    }
    else if (gameState.phase === 'celebrating') {
        // Update ONLY the winner
        if (gameState.winner) {
            const winnerFw = gameState.fireworks.find(fw => fw.id === gameState.winner.id);
            if (winnerFw) {
                winnerFw.update(elapsedTime);
                // Tight camera lock on winner
                const targetHeight = 1.0 - winnerFw.y;
                gameState.cameraY += (targetHeight - gameState.cameraY) * 0.1;
            }
        }
    }
}

function startCelebration(winner) {
    if (gameState.phase === 'celebrating') return;

    console.log(`🎉 Celebration started for ${winner.wallet}`);
    gameState.phase = 'celebrating';
    gameState.winner = winner.toJSON(); // Mark winner early

    // Explode everyone else
    gameState.fireworks.forEach(fw => {
        if (fw.id !== winner.id) fw.explode();
    });

    // 3 Seconds of Solo Flight/Zoom
    setTimeout(() => {
        endRound(winner);
    }, 3000);
}

function endRound(winner) {
    gameState.winner = winner.toJSON();
    gameState.phase = 'ended';

    const prizeForThisRound = gameState.prizePool;

    gameState.winners.unshift({
        wallet: winner.wallet,
        fullWallet: winner.fullWallet || winner.wallet,
        round: gameState.currentRound,
        prize: prizeForThisRound,
        height: Math.floor(winner.heightReached),
        timestamp: Date.now()
    });

    if (gameState.winners.length > 20) {
        gameState.winners = gameState.winners.slice(0, 20);
    }

    gameState.totalDistributed += parseFloat(prizeForThisRound);

    console.log(`🏆 Round #${gameState.currentRound} winner: ${winner.wallet} (${Math.floor(winner.heightReached)}m)`);

    gameState.timeRemaining = 30; // Start 30s break countdown

    // Distribute THIS round's prize to winner (via hot wallets)
    if (prizeForThisRound > 0 && winner.fullWallet) {
        console.log(`💸 Distributing ${prizeForThisRound} SOL to winner...`);
        distributeToWinner(winner.fullWallet, parseFloat(prizeForThisRound)).then(distResult => {
            if (distResult.success) {
                console.log(`✅ Prize distributed to ${winner.wallet}`);
            } else {
                console.log(`⚠️ Distribution failed: ${distResult.error}`);
            }
        });
    }

    // Fee claiming now happens 5 seconds before next round

    // Save stats to persist across deploys
    saveStats();

    // Broadcast immediately so client sees "ended" state logic
    io.emit('roundEnded', {
        winner: gameState.winner,
        prizePool: prizeForThisRound,
        round: gameState.currentRound
    });
}

function getGameStateForClient() {
    return {
        currentRound: gameState.currentRound,
        timeRemaining: gameState.timeRemaining,
        prizePool: gameState.prizePool,
        totalDistributed: gameState.totalDistributed.toFixed(2),
        totalHolders: realHolders.length,
        fireworks: gameState.fireworks.map(fw => fw.toJSON()),
        winner: gameState.winner,
        phase: gameState.phase,
        winners: gameState.winners.slice(0, 10),
        cameraY: gameState.cameraY,
        claimStatus: gameState.claimStatus,
        lastClaimedAmount: gameState.lastClaimedAmount
    };
}

// ==========================================
// GAME LOOPS
// ==========================================

// Physics update (60 FPS)
setInterval(() => {
    updateGame();
}, 1000 / CONFIG.TICK_RATE);

// Broadcast state (30 FPS)
setInterval(() => {
    if (gameState.phase === 'racing' || gameState.phase === 'celebrating' || gameState.phase === 'ended') {
        io.emit('gameState', getGameStateForClient());
    }
}, 1000 / 30);

// Timer countdown
setInterval(() => {
    // RACING PHASE
    if (gameState.phase === 'racing' && gameState.timeRemaining > 0) {
        gameState.timeRemaining--;

        if (gameState.timeRemaining === 0) {
            const active = gameState.fireworks.filter(fw => !fw.hasExploded);
            if (active.length > 0) {
                const winner = gameState.fireworks.reduce((max, fw) =>
                    fw.heightReached > max.heightReached ? fw : max
                );
                startCelebration(winner);
            } else {
                // Technically impossible if loop is right, but fallback
                startNewRound();
            }
        }
    }
    // BREAK PHASE (Intermission) - also handle claiming phase
    else if (gameState.phase === 'ended' || gameState.phase === 'claiming') {
        if (gameState.timeRemaining > 0) {
            gameState.timeRemaining--;

            // Claim fees 5 seconds before next round
            if (gameState.timeRemaining === 5 && gameState.claimStatus !== 'claiming') {
                console.log('🔄 5 seconds left - claiming fees for next round...');
                gameState.claimStatus = 'claiming';
                io.emit('gameState', getGameStateForClient());

                claimCreatorFees().then(result => {
                    if (result.success) {
                        gameState.prizePool = (result.amount * 0.9).toFixed(4);
                        gameState.lastClaimedAmount = result.amount;
                        gameState.claimStatus = 'claimed';
                        console.log(`💰 Claimed! Next round prize: ${gameState.prizePool} SOL`);
                    } else {
                        gameState.prizePool = 0;
                        gameState.claimStatus = 'failed';
                        console.log('⚠️ Claim failed - prize is 0');
                    }
                });
            }
        } else {
            // Break is over - start new round
            gameState.currentRound++;
            startNewRound();
        }
    }
}, 1000);

// Refresh holders every 5 minutes
setInterval(() => {
    fetchTokenHolders();
}, 5 * 60 * 1000);

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
    console.log(`👤 User connected: ${socket.id}`);
    socket.emit('gameState', getGameStateForClient());
    socket.emit('winners', gameState.winners);

    socket.on('disconnect', () => {
        console.log(`👤 User disconnected: ${socket.id}`);
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 $FIREWORK Server running on port ${PORT}`);
    console.log(`🎆 Happy New Year 2025!`);
    console.log(`📍 Token: ${TOKEN_CA}`);

    // Fetch real holders first
    await fetchTokenHolders();

    // Start first round
    startNewRound();
});
