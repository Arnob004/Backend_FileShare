import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";

const app = express();
export const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://file-share-puce-rho.vercel.app",
    methods: ["GET", "POST"],
    credentials: true,
  },
});
app.use(express.json());
// In-memory store for online users
let onlineUsers = {};
// Helper to get socket ID by user ID
const getUserSocketId = (uid) => {
  return onlineUsers[uid]?.socketId || null;
};
io.on("connection", (socket) => {
  // Handle new user
  socket.on("new_user", (userData) => {
    if (!userData?.uid || !userData?.name) {
      socket.emit("error", { message: "User ID and name are required" });
      console.error("Invalid user data:", userData);
      return;
    }
    onlineUsers[userData.uid] = { ...userData, socketId: socket.id };
    io.emit("update_online_users", Object.values(onlineUsers));
    // console.log(`User connected: ${userData.uid}`);
  });
  // Send join request to another user
  socket.on("send_request", ({ to, from, roomId }) => {
    if (!to || !from || !roomId) {
      socket.emit("error", {
        message: "Recipient ID, sender ID, and room ID are required",
      });
      // console.error("Invalid request data:", { to, from, roomId });
      return;
    }
    const receiverSocketId = getUserSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receive_request", { from, roomId });
      // console.log(`Request sent from ${from} to ${to} for room ${roomId}`);
    } else {
      socket.emit("error", { message: `User ${to} not found` });
    }
  });
  // Handle accepting a connection request
  socket.on("accept_request", ({ to, from, roomId }) => {
    if (!to || !from || !roomId) {
      socket.emit("error", {
        message: "Recipient ID, sender ID, and room ID are required",
      });
      console.error("Invalid accept request data:", { to, from, roomId });
      return;
    }
    const receiverSocketId = getUserSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("request_accepted", { from, roomId });
      // console.log(`Request accepted from ${from} to ${to} for room ${roomId}`);
    } else {
      socket.emit("error", { message: `User ${to} not found` });
    }
  });
  // Handle declining a connection request
  socket.on("decline_request", ({ to, from }) => {
    if (!to || !from) {
      socket.emit("error", {
        message: "Recipient ID and sender ID are required",
      });
      // console.error("Invalid decline request data:", { to, from });
      return;
    }
    const receiverSocketId = getUserSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("request_declined", from);
      // console.log(`Request declined from ${from} to ${to}`);
    } else {
      socket.emit("error", { message: `User ${to} not found` });
    }
  });
  // Join a room and notify others
  socket.on("join_room", ({ roomId, user, from }) => {
    if (!roomId || !user?.uid || !user?.name || !from?.name) {
      socket.emit("error", {
        message: "Room ID and user data (ID, name) are required",
      });
      // console.error("Invalid join room data:", { roomId, user, from });
      return;
    }
    socket.join(roomId);
    socket.roomId = roomId;
    socket.user = user;
    socket.from = from;
    // Notify others in the room about the new user
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    clients.forEach((clientId) => {
      if (clientId !== socket.id) {
        io.to(clientId).emit("connected_user", user);
      }
    });
    // console.log(`User ${user.uid} joined room ${roomId}`);
  });
  // Broadcast uploaded file to room members
  socket.on("upload_file", (file) => {
    if (!socket.roomId) {
      socket.emit("error", { message: "Not in a room" });
      return;
    }
    if (!file?.name) {
      socket.emit("error", { message: "File name is required" });
      // console.error("Invalid file data:", file);
      return;
    }
    socket.to(socket.roomId).emit("new_file", file);
    // console.log(`File uploaded in room ${socket.roomId}: ${file.name}`);
  });
  // Handle user manually leaving a room
  socket.on("leave_room", () => {
    if (socket.roomId && socket.user) {
      socket.to(socket.roomId).emit("user_left", socket.user);
      socket.leave(socket.roomId);
      // console.log(`User ${socket.user.uid} left room ${socket.roomId}`);
      socket.roomId = null; // reset
    }
  });

  // Handle user disconnection
  socket.on("disconnect", () => {
    if (socket.roomId && socket.user) {
      socket.to(socket.roomId).emit("user_left", socket.user);
    }
    // Remove user from onlineUsers
    for (let uid in onlineUsers) {
      if (onlineUsers[uid].socketId === socket.id) {
        // console.log(`User disconnected: ${uid}`);
        delete onlineUsers[uid];
        break;
      }
    }
    io.emit("update_online_users", Object.values(onlineUsers));
  });
});
