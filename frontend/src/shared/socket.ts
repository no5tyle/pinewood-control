import socketIOClient from "socket.io-client";
import { apiOrigin } from "./api";

export const socket = socketIOClient(apiOrigin || "/");

