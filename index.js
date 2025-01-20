const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active games and waiting rooms
const games = new Map();
const waitingRooms = new Map();

class Player {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.points = 0;
        this.isAlive = true;
        this.number = null;
    }
}

class DeathGame {
    constructor(players) {
        this.players = players;
        this.round = 1;
        this.eliminatedCount = 0;
        this.roundStartTime = null;
        this.currentPhase = 'waiting'; // waiting, playing, roundEnd
        this.roundNumbers = new Map();
    }

    startRound() {
        this.currentPhase = 'playing';
        this.roundStartTime = Date.now();
        this.roundNumbers.clear();
        return {
            round: this.round,
            timeLimit: this.isNewRuleRound() ? 300 : 60,
            playersRemaining: this.getAlivePlayers().length
        };
    }

    submitNumber(playerId, number) {
        if (this.currentPhase !== 'playing') return false;
        if (!this.players.get(playerId)?.isAlive) return false;
        
        this.roundNumbers.set(playerId, number);
        return this.roundNumbers.size === this.getAlivePlayers().length;
    }

    calculateRoundResults() {
        const numbers = Array.from(this.roundNumbers.values());
        const avg = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        const target = avg * 0.8;
        
        // Find duplicates
        const duplicates = numbers.filter((num, index) => 
            numbers.indexOf(num) !== index
        );

        // Special rule for 2 players
        if (this.getAlivePlayers().length === 2) {
            if (numbers.includes(0) && numbers.includes(100)) {
                const winnerId = Array.from(this.roundNumbers.entries())
                    .find(([_, num]) => num === 100)[0];
                return {
                    winner: this.players.get(winnerId),
                    gameOver: true,
                    specialRule: true
                };
            }
        }

        // Find winner
        let closestPlayer = null;
        let closestDistance = Infinity;

        for (const [playerId, number] of this.roundNumbers) {
            if (duplicates.includes(number) && this.getAlivePlayers().length <= 4) 
                continue;

            const distance = Math.abs(number - target);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestPlayer = this.players.get(playerId);
            }
        }

        // Apply penalties
        for (const [playerId, number] of this.roundNumbers) {
            const player = this.players.get(playerId);
            if (player !== closestPlayer) {
                let penalty = -1;
                if (this.getAlivePlayers().length === 3 && number === target) {
                    penalty *= 2;
                }
                player.points += penalty;
            }
        }

        // Check eliminations
        let newEliminations = [];
        for (const player of this.players.values()) {
            if (player.isAlive && player.points <= -10) {
                player.isAlive = false;
                this.eliminatedCount++;
                newEliminations.push(player);
            }
        }

        return {
            numbers: Object.fromEntries(this.roundNumbers),
            average: avg,
            target,
            winner: closestPlayer,
            duplicates,
            eliminations: newEliminations,
            gameOver: this.getAlivePlayers().length <= 1
        };
    }

    getAlivePlayers() {
        return Array.from(this.players.values()).filter(p => p.isAlive);
    }

    isNewRuleRound() {
        return this.round === 1 || 
               this.eliminatedCount === this.players.size - 4 || 
               this.eliminatedCount === this.players.size - 3 || 
               this.eliminatedCount === this.players.size - 2;
    }
}

// Socket.IO event handlers
io.on('connection', (socket) => {
    // Create a new game room
    socket.on('createRoom', ({ playerName }) => {
        const roomCode = generateRoomCode();
        const player = new Player(socket.id, playerName);
        
        waitingRooms.set(roomCode, {
            host: socket.id,
            players: new Map([[socket.id, player]])
        });
        
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode, playerId: socket.id });
    });

    // Join an existing room
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = waitingRooms.get(roomCode);
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        if (room.players.size >= 5) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }

        const player = new Player(socket.id, playerName);
        room.players.set(socket.id, player);
        
        socket.join(roomCode);
        socket.emit('joinedRoom', { 
            roomCode,
            playerId: socket.id
        });

        io.to(roomCode).emit('playerJoined', {
            players: Array.from(room.players.values())
        });

        // Start game if 5 players have joined
        if (room.players.size === 5) {
            const game = new DeathGame(room.players);
            games.set(roomCode, game);
            waitingRooms.delete(roomCode);
            
            const roundInfo = game.startRound();
            io.to(roomCode).emit('gameStart', roundInfo);
        }
    });

    // Submit number for current round
    socket.on('submitNumber', ({ roomCode, number }) => {
        const game = games.get(roomCode);
        if (!game) return;

        const allSubmitted = game.submitNumber(socket.id, number);
        if (allSubmitted) {
            const results = game.calculateRoundResults();
            io.to(roomCode).emit('roundResults', results);

            if (results.gameOver) {
                io.to(roomCode).emit('gameOver', {
                    winner: results.winner,
                    finalScores: Array.from(game.players.values())
                });
                games.delete(roomCode);
            } else {
                // Start next round after 10 seconds
                setTimeout(() => {
                    game.round++;
                    const roundInfo = game.startRound();
                    io.to(roomCode).emit('roundStart', roundInfo);
                }, 10000);
            }
        }
    });

    socket.on('disconnect', () => {
        // Handle disconnection logic
    });
});

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});