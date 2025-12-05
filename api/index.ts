/**
 * VidSync Signalling Server
 * - Uses Socket.IO for real-time signalling
 * - Manages rooms and peer connections
 */
import { Server } from "socket.io";
import "dotenv/config";

/** 
 * Parse and clean origins from environment variable
 */
const origins = (process.env.ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Allow single origin or array
// This code parses the ORIGIN environment variable to support either a single origin or a comma-separated list of origins.
// It trims whitespace and filters out any empty values to ensure a clean array of origins.
const io = new Server({
  cors: {
    origin: origins.length ? origins : "*"
  }
});

const port = Number(process.env.PORT || 3002);

io.listen(port);
//console.log(`Signalling server is running on port ${port}`);

/**
 * Data structure to keep track of peers in each room.
 * The keys are room names, and the values are objects mapping socket IDs to true.
 */
const peersByRoom: Record<string, Record<string, true>> = {};

/** 
 * Signalling server logic
 * - joinRoom: join a specific room (meeting code)
 * - leaveRoom: leave a specific room
 * - signal: relay signalling data between peers in the same room
 */
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // join a room (meeting code)
  socket.on("joinRoom", (roomRaw: any) => {
    const room = (roomRaw ?? "").toString().trim();
    if (!room) {
      console.warn("joinRoom called with empty room by", socket.id);
      return;
    }

    // leave any previously joined room
    const prevRoom = socket.data?.room as string | undefined;
    if (prevRoom && prevRoom !== room) {
      socket.leave(prevRoom);
      if (peersByRoom[prevRoom]) {
        delete peersByRoom[prevRoom][socket.id];
        io.to(prevRoom).emit("userDisconnected", socket.id);
      }
    }

    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;

    peersByRoom[room] = peersByRoom[room] ?? {};
    peersByRoom[room][socket.id] = true;

    // send introduction: list of peers in same room (excluding self)
    const otherIds = Object.keys(peersByRoom[room]).filter((id) => id !== socket.id);
    socket.emit("introduction", otherIds);

    // notify room about new peer
    io.to(room).emit("newUserConnected", socket.id);

    console.log(`Socket ${socket.id} joined room ${room} (peers: ${Object.keys(peersByRoom[room]).length})`);
  });

  /** 
   * Explicitly leave a room 
   * - Remove the socket from the specified room
   * - Notify other peers in the room about the disconnection
   * - Clean up empty rooms
  */
  socket.on("leaveRoom", (roomRaw: any) => {
    const room = (roomRaw ?? "").toString().trim();
    if (!room) return;
    socket.leave(room);
    if (peersByRoom[room]) {
      delete peersByRoom[room][socket.id];
      io.to(room).emit("userDisconnected", socket.id);
      if (Object.keys(peersByRoom[room]).length === 0) delete peersByRoom[room];
    }
    if (socket.data) {
      delete socket.data.room;
    }
    console.log(`Socket ${socket.id} left room ${room}`);
  });

  /**
   * Relay signalling data between peers in the same room
   * - The server receives signalling data from one peer and forwards it to the target peer
   */
  socket.on("signal", (to: string, from: string, data: any) => {
    const room = socket.data?.room as string | undefined;
    if (!room) {
      console.warn("signal received from socket not in a room:", socket.id);
      return;
    }
    // target must be in same room
    if (!peersByRoom[room] || !peersByRoom[room][to]) {
      console.warn(`Signal target ${to} not found in room ${room}`);
      return;
    }
    // forward to specific socket id
    io.to(to).emit("signal", to, from, data);
  });

  /**  
   * Handle socket disconnection
   * - Remove the socket from its room
   * - Notify other peers in the room about the disconnection
   * - Clean up empty rooms
   */
  socket.on("disconnect", () => {
    const room = socket.data?.room as string | undefined;
    if (room && peersByRoom[room]) {
      delete peersByRoom[room][socket.id];
      io.to(room).emit("userDisconnected", socket.id);
      if (Object.keys(peersByRoom[room]).length === 0) delete peersByRoom[room];
    }
    console.log("Socket disconnected:", socket.id);
  });

  /**  
   * Announce identity to a room
   * - A socket can announce its identity (name) to all peers in a room
   * - The server relays the announcement to all sockets in the specified room
   */
  socket.on("announce", (payload: { room?: string; name?: string }) => {
    const room = (payload?.room ?? socket.data?.room ?? "").toString().trim();
    if (!room) return;
    io.to(room).emit("announce", { socketId: socket.id, name: payload?.name ?? null });
  });

  /** 
   * Request identity for a socket in a room
   * - The requesting socket asks a target socket to announce its identity (name)
   * - The target socket responds by emitting an "askToAnnounce" event back to the requester
   */
  socket.on("requestIdentityFor", (payload: { room?: string; socketId?: string }) => {
    const room = (payload?.room ?? socket.data?.room ?? "").toString().trim();
    const target = payload?.socketId ?? "";
    if (!room || !target) return;
    io.to(target).emit("askToAnnounce");
  });
});