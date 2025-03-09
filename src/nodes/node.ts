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

    const state = {
        killed: false,
        x: isFaulty ? null : initialValue,
        decided: isFaulty ? null : false,
        k: isFaulty ? null : 0,
    };

    let consensusRunning = false;

    const messageBuffer: Map<number, (0 | 1)[]> = new Map();

    app.get("/status", (req, res) => {
        if (isFaulty) {
            res.status(500).send("faulty");
        } else {
            res.status(200).send("live");
        }
    });

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

    app.get("/stop", (req, res) => {
        if (!isFaulty) {
            state.killed = true;
        }
        res.send("stopped");
    });

    app.get("/start", (req, res) => {
        if (!isFaulty && !consensusRunning && !state.killed) {
            consensusRunning = true;
            runConsensus();
        }
        res.send("started");
    });

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


    async function runConsensus(): Promise<void> {
        while (!state.killed && state.decided !== true) {
            const currentRound = state.k as number;
            if (!messageBuffer.has(currentRound)) {
                messageBuffer.set(currentRound, []);
            }
            messageBuffer.get(currentRound)?.push(state.x as 0 | 1);

            for (let i = 0; i < N; i++) {
                if (i === nodeId) continue;
                const url = `http://localhost:${BASE_NODE_PORT + i}/message`;
                fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ round: currentRound, value: state.x }),
                }).catch(() => {
                });
            }

            await delay(100);

            const messages = messageBuffer.get(currentRound) || [];
            const count0 = messages.filter((v) => v === 0).length;
            const count1 = messages.filter((v) => v === 1).length;

            const threshold = N - F;
            if (N > 2 * F && count0 >= threshold && count0 > count1) {
                state.x = 0;
                state.decided = true;
            } else if (N > 2 * F && count1 >= threshold && count1 > count0) {
                state.x = 1;
                state.decided = true;
            } else {
                if (count0 > count1) {
                    state.x = 0;
                } else if (count1 > count0) {
                    state.x = 1;
                } else {
                    state.x = Math.round(Math.random()) as 0 | 1;
                }
            }

            if (!state.killed && state.decided !== true) {
                state.k = (state.k as number) + 1;
            }

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