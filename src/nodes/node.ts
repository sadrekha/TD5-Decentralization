import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";
import { delay } from "../utils";

export async function node(
    nodeId: number, // the ID of the node
    N: number, // total number of nodes in the network
    F: number, // number of faulty nodes in the network
    initialValue: Value, // initial value of the node
    isFaulty: boolean, // true if the node is faulty, false otherwise
    nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
    setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
    const app = express();
    app.use(express.json());
    app.use(bodyParser.json());

    // Node state
    const state = {
        killed: false,
        x: isFaulty ? null : initialValue,
        decided: isFaulty ? null : false, // non-faulty nodes start with not decided (false)
        k: isFaulty ? null : 0,
    };

    // Flag to indicate if the consensus algorithm is running
    let consensusRunning = false;

    // Message buffer: maps round number to an array of received values
    const messageBuffer: Map<number, (0 | 1)[]> = new Map();

    // /status route: returns 500 "faulty" for faulty nodes, 200 "live" for healthy ones
    app.get("/status", (req, res) => {
        if (isFaulty) {
            res.status(500).send("faulty");
        } else {
            res.status(200).send("live");
        }
    });

    // /getState route: returns the current state, or null fields if faulty
    app.get("/getState", (req, res) => {
        if (isFaulty) {
            res.json({
                killed: state.killed,
                x: null,
                decided: null,
                k: null,
            });
        } else {
            res.json(state);
        }
    });

    // /stop route: stops the consensus algorithm (sets killed flag)
    app.get("/stop", (req, res) => {
        if (!isFaulty) {
            state.killed = true;
        }
        res.send("stopped");
    });

    // /start route: starts the consensus algorithm (if non-faulty)
    app.get("/start", (req, res) => {
        if (!isFaulty && !consensusRunning && !state.killed) {
            consensusRunning = true;
            runConsensus();
        }
        res.send("started");
    });

    // /message route: receives messages from other nodes and stores them by round
    app.post("/message", (req, res) => {
        if (isFaulty || state.killed) {
            return res.sendStatus(200);
        }
        const { round, value } = req.body;
        if (typeof round !== "number" || (value !== 0 && value !== 1)) {
            return res.status(400).send("Invalid message");
        }
        if (!messageBuffer.has(round)) {
            messageBuffer.set(round, []);
        }
        messageBuffer.get(round)?.push(value);
        return res.sendStatus(200);
    });


    // Consensus algorithm implementation (Ben‐Or variant)
    async function runConsensus(): Promise<void> {
        while (!state.killed && state.decided !== true) {
            const currentRound = state.k as number; // safe because non-faulty
            // Ensure a message array exists for the current round
            if (!messageBuffer.has(currentRound)) {
                messageBuffer.set(currentRound, []);
            }
            // Include own value in the message buffer for this round
            messageBuffer.get(currentRound)?.push(state.x as 0 | 1);

            // Broadcast current value to all other nodes
            for (let i = 0; i < N; i++) {
                if (i === nodeId) continue;
                const url = `http://localhost:${BASE_NODE_PORT + i}/message`;
                fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ round: currentRound, value: state.x }),
                }).catch(() => {
                    // Ignore fetch errors
                });
            }

            // Wait for a short time to allow messages to arrive (simulate network delay)
            await delay(100);

            // Process messages for this round
            const messages = messageBuffer.get(currentRound) || [];
            const count0 = messages.filter((v) => v === 0).length;
            const count1 = messages.filter((v) => v === 1).length;

            // The decision threshold is N - F, but we only decide if N > 2F (otherwise consensus is impossible)
            const threshold = N - F;
            if (N > 2 * F && count0 >= threshold && count0 > count1) {
                state.x = 0;
                state.decided = true;
            } else if (N > 2 * F && count1 >= threshold && count1 > count0) {
                state.x = 1;
                state.decided = true;
            } else {
                // No decision: update current estimate to the majority value, or coin toss in case of a tie
                if (count0 > count1) {
                    state.x = 0;
                } else if (count1 > count0) {
                    state.x = 1;
                } else {
                    state.x = Math.round(Math.random()) as 0 | 1;
                }
            }

            // If still undecided, increment round counter and continue
            if (!state.killed && state.decided !== true) {
                state.k = (state.k as number) + 1;
            }

            // Short delay before next round
            await delay(10);
        }
    }

    // Start the server
    const server = app.listen(BASE_NODE_PORT + nodeId, () => {
        console.log(
            `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
        );

        // the node is ready
        setNodeIsReady(nodeId);
    });

    return server;
}