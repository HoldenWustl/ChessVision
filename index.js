const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { spawn } = require("child_process");
const path = require("path");
const { Chess } = require("chess.js");

const ENGINE_PATH = path.join(__dirname, "engine", "lc0.exe");
const MAIA_NET_PATH = path.resolve(__dirname, "engine", "1500.pb");

function buildPieceOnlyFen(pieces) {
  const board = Array.from({ length: 8 }, () => Array(8).fill("."));
  for (const p of pieces) {
    if (!p.squareNum || !p.pieceClass) continue;
    const num = Number(p.squareNum);
    const file = Math.floor(num / 10);
    const rank = num % 10;
    if (file < 1 || file > 8 || rank < 1 || rank > 8) continue;
    const color = p.pieceClass[0];
    const type = p.pieceClass[1];
    const map = { p: "p", r: "r", n: "n", b: "b", q: "q", k: "k" };
    const c = color === "w" ? map[type].toUpperCase() : map[type];
    board[8 - rank][file - 1] = c;
  }
  return board
    .map(row => {
      let str = "", empty = 0;
      for (const cell of row) {
        if (cell === ".") empty++;
        else {
          if (empty > 0) { str += empty; empty = 0; }
          str += cell;
        }
      }
      if (empty > 0) str += empty;
      return str;
    })
    .join("/");
}

async function getPieces(page) {
  const pieces = await page.$$eval(".piece", nodes =>
    nodes.map(n => {
      const classes = Array.from(n.classList);
      const pieceClass = classes.find(c => /^[wb][prnbqk]$/.test(c));
      const squareClass = classes.find(c => c.startsWith("square-"));
      const num = squareClass ? squareClass.split("-")[1] : null;
      return { pieceClass, squareNum: num };
    })
  );
  return { pieces, numPieces: pieces.length };
}

let currentEngine = null; 
let currentSearch = null; 

async function initEngine() {
  currentEngine = spawn(ENGINE_PATH);
  let buffer = "";
  let readyResolve = null;
  const readyPromise = new Promise((res) => { readyResolve = res; });
  
  currentEngine.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (line === "readyok" && readyResolve) {
        readyResolve();
        readyResolve = null; 
        return;
      }
      if (!currentSearch) continue; 
      if (line.startsWith("bestmove")) {
        const move = line.split(" ")[1];
        if (currentSearch.isCancelled) {
          currentSearch.reject(new Error("Search cancelled by new board state."));
        } else {
          currentSearch.resolve(move);
        }
        currentSearch = null;
        return; 
      }
    }
  });
  
  currentEngine.stderr.on("data", (data) => {
    console.error(`Engine STDERR: ${data}`);
  });
  
  currentEngine.on("close", (code) => {
    console.log(`Engine closed with code ${code}`);
    currentEngine = null;
    if (currentSearch && !currentSearch.isCancelled) {
      currentSearch.reject(new Error(`Engine process exited with code ${code}`));
      currentSearch = null;
    }
  });
  
  currentEngine.on("error", (err) => {
    console.error("Engine error:", err);
    currentEngine = null;
    if (currentSearch) {
      currentSearch.reject(err);
      currentSearch = null;
    }
  });
  
  currentEngine.stdin.write("uci\n");
  currentEngine.stdin.write(`setoption name Backend value blas\n`);
  currentEngine.stdin.write(`setoption name Threads value 8\n`);
  currentEngine.stdin.write(`setoption name WeightsFile value ${MAIA_NET_PATH}\n`);
  currentEngine.stdin.write("isready\n");
  
  await readyPromise;
  
  await new Promise((resolve) => {
    const listener = (data) => {
      if (data.toString().includes("bestmove")) {
        currentEngine.stdout.off("data", listener);
        resolve();
      }
    };
    currentEngine.stdout.on("data", listener);
    currentEngine.stdin.write("position startpos\n");
    currentEngine.stdin.write("go nodes 500\n");
  });
  console.log("Engine initialized and ready.");
}

function algebraicToSquareNum(alg) {
  const files = "abcdefgh";
  const fileChar = alg[0];
  const rankChar = alg[1];
  const fileNum = files.indexOf(fileChar) + 1;
  const rankNum = parseInt(rankChar, 10);
  return `${fileNum}${rankNum}`; 
}

function squareNumToAlgebraic(numStr) {
  const files = "abcdefgh";
  const fileNum = parseInt(numStr[0], 10);
  const rankNum = parseInt(numStr[1], 10);
  return `${files[fileNum - 1]}${rankNum}`;
}

// Global Mouse Tracking for Smooth Curves and Fidgeting
let lastMouseX = 400; 
let lastMouseY = 400;

function getQuadraticCurve(startX, startY, endX, endY, steps = 10) {
  const path = [];
  const dx = endX - startX;
  const dy = endY - startY;
  const bow = (Math.random() - 0.5) * 0.3; 
  const ctrlX = startX + dx / 2 - dy * bow;
  const ctrlY = startY + dy / 2 + dx * bow;

  for (let i = 1; i <= steps; i++) {
    let t = i / steps;
    const easedT = t * (2 - t); 
    const x = Math.pow(1 - easedT, 2) * startX + 2 * (1 - easedT) * easedT * ctrlX + Math.pow(easedT, 2) * endX;
    const y = Math.pow(1 - easedT, 2) * startY + 2 * (1 - easedT) * easedT * ctrlY + Math.pow(easedT, 2) * endY;
    path.push({ x, y });
  }
  return path;
}

async function moveMouseSmoothly(page, startX, startY, endX, endY, steps) {
  const curve = getQuadraticCurve(startX, startY, endX, endY, steps);
  for (const point of curve) {
    await page.mouse.move(point.x, point.y);
  }
  lastMouseX = endX;
  lastMouseY = endY;
}

async function humanFidget(page) {
  if (Math.random() > 0.3) return;

  const driftX = lastMouseX + (Math.random() * 100 - 50);
  const driftY = lastMouseY + (Math.random() * 100 - 50);
  
  const safeX = Math.max(100, Math.min(800, driftX));
  const safeY = Math.max(100, Math.min(800, driftY));

  await moveMouseSmoothly(page, lastMouseX, lastMouseY, safeX, safeY, 15);
  
  if (Math.random() < 0.1) {
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 20 + Math.random() * 50));
    await page.mouse.up();
  }
}

async function makeMove(page, move, isWhiteToMove) {
  try {
    const fromAlg = move.slice(0, 2);
    const toAlg = move.slice(2, 4);
    const fromSqNum = algebraicToSquareNum(fromAlg);
    const toSqNum = algebraicToSquareNum(toAlg);
    
    const fromSelector = `.piece.square-${fromSqNum}`;
    const toSelector = [
      `.piece.square-${toSqNum}`,
      `.hint.square-${toSqNum}`,
      `.capture-square.square-${toSqNum}`
    ].join(', ');
    
    console.log(`🤖 Making move: ${move}`);
    
    const fromElement = await page.waitForSelector(fromSelector, { visible: true, timeout: 3000 });
    const fromBox = await fromElement.boundingBox();
    const fromX = fromBox.x + (fromBox.width / 2) + (Math.random() * 10 - 5);
    const fromY = fromBox.y + (fromBox.height / 2) + (Math.random() * 10 - 5);
    
    await moveMouseSmoothly(page, lastMouseX, lastMouseY, fromX, fromY, 8);
    await page.mouse.down();
    
    try {
      await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
      
      let toElement = null;
      for (let i = 0; i < 3 && !toElement; i++) {
        try {
          toElement = await page.waitForSelector(toSelector, { visible: true, timeout: 1000 });
        } catch { }
      }
      if (!toElement) throw new Error(`Target square not found for ${move}`);
      
      const toBox = await toElement.boundingBox();
      const toX = toBox.x + (toBox.width / 2) + (Math.random() * 10 - 5);
      const toY = toBox.y + (toBox.height / 2) + (Math.random() * 10 - 5);
      
      await moveMouseSmoothly(page, fromX, fromY, toX, toY, 12);
      
      await new Promise(r => setTimeout(r, 20 + Math.random() * 50));
    } finally {
      await page.mouse.up();
    }
    
    if (move.length === 5) {
      const promotionPiece = move.slice(4, 5);
      const color = isWhiteToMove ? 'w' : 'b';
      const promoSelector = `.promotion-piece.${color}${promotionPiece}`;
      const promoElement = await page.waitForSelector(promoSelector, { visible: true, timeout: 5000 });
      await new Promise(r => setTimeout(r, 100));
      
      const promoBox = await promoElement.boundingBox();
      lastMouseX = promoBox.x + promoBox.width / 2;
      lastMouseY = promoBox.y + promoBox.height / 2;
      
      await promoElement.click();
    }
  } catch (e) {
    throw new Error(`Error making move ${move}: ${e.message}`);
  }
}

function randomDelayBiased(minMs = 500, maxMs = 5000, bias = 3.5) {
  const u = Math.random(); 
  const v = Math.pow(u, bias); 
  const ms = Math.round(minMs + (maxMs - minMs) * v);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBestMove(fenWithTurn, maxDepth) {
  if (!currentEngine) throw new Error("Engine not initialized.");
  if (currentSearch) {
    currentSearch.isCancelled = true;
    currentEngine.stdin.write("stop\n");
    try { await currentSearch.promise; } catch { } 
  }
  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const timeoutId = setTimeout(() => {
    if (!currentSearch.isCancelled) {
      rejectFn(new Error("Engine search timed out."));
    }
  }, 10000);
  currentSearch = {
    promise,
    resolve: (move) => { clearTimeout(timeoutId); resolveFn(move); },
    reject: (err) => { clearTimeout(timeoutId); rejectFn(err); },
    isCancelled: false,
    fen: fenWithTurn,
  };
  setTimeout(() => {
    if (currentEngine && !currentSearch.isCancelled) {
      currentEngine.stdin.write(`position fen ${fenWithTurn}\n`);
      currentEngine.stdin.write(`go depth ${maxDepth}\n`);
    }
  }, 50);
  return promise;
}

const STARTING_FEN_PIECES = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

(async () => {
  const url = process.argv[2] || "https://www.chess.com/play/online";
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
  const [page] = await browser.pages();
  console.log("Opening:", url);
  await page.goto(url, { waitUntil: "networkidle2" });
  
  try {
    await page.waitForSelector(".piece", { timeout: 20000 });
    await page.waitForSelector("svg.arrows", { timeout: 10000 });
  } catch {
    console.log("⚠️ Board or arrows SVG not detected yet. Open a game.");
    return;
  }
  console.log("✅ Board detected. Watching for changes...");
  
  await initEngine();
  const chess = new Chess();
  
  // --- STATE VARIABLES ---
  let needsSyncRetry = false; 
  let syncRetryCount = 0;
  let handlingBoard = false;
  
  // NEW: Global Fidget and Turn Tracking Variables
  let isBotTurn = false; 
  let lastFidgetTime = Date.now();
  let nextFidgetDelay = 3000 + Math.random() * 2000;

  function getPieceOnlyFen(fullFen) {
    return fullFen.split(' ')[0];
  }

  async function handleBoardChange() {
    if (handlingBoard) return;
    handlingBoard = true;
    try {
      const { pieces, numPieces } = await getPieces(page);
      const domFenPieces = buildPieceOnlyFen(pieces);
      const internalFenPieces = getPieceOnlyFen(chess.fen());
      
      // 1. Check if game restarted
      if (domFenPieces === STARTING_FEN_PIECES && internalFenPieces !== STARTING_FEN_PIECES) {
        console.log("♟️ New Game Detected. Resetting internal state.");
        chess.reset();
        needsSyncRetry = false;
      } 
      // 2. Sync State: Find the missing move
      else if (domFenPieces !== getPieceOnlyFen(chess.fen())) {
        let foundMove = null;
        const highlights = await page.$$eval('.highlight', nodes => 
          nodes.map(n => {
            const cls = Array.from(n.classList).find(c => c.startsWith('square-'));
            return cls ? cls.split('-')[1] : null;
          }).filter(Boolean)
        );
        if (highlights.length === 2) {
          const sq1 = squareNumToAlgebraic(highlights[0]);
          const sq2 = squareNumToAlgebraic(highlights[1]);
          const matchingMoves = chess.moves({ verbose: true }).filter(m => 
            (m.from === sq1 && m.to === sq2) || (m.from === sq2 && m.to === sq1)
          );
          if (matchingMoves.length > 0) {
            foundMove = matchingMoves[0];
            if (matchingMoves.length > 1) { 
              const toSqAlg = matchingMoves[0].to; 
              const toSqNum = algebraicToSquareNum(toSqAlg);
              const promotedPieceDOM = pieces.find(p => p.squareNum === toSqNum);
              if (promotedPieceDOM) {
                const type = promotedPieceDOM.pieceClass[1]; 
                foundMove = matchingMoves.find(m => m.promotion === type) || matchingMoves[0];
              }
            }
          }
        }
        if (!foundMove) {
          const legalMoves = chess.moves({ verbose: true });
          for (const m of legalMoves) {
            const tempChess = new Chess(chess.fen());
            tempChess.move(m.san);
            if (getPieceOnlyFen(tempChess.fen()) === domFenPieces) {
              foundMove = m;
              break;
            }
          }
        }
        if (foundMove) {
          try {
            chess.move(foundMove.san);
            console.log(`\n♟️ Opponent played: ${foundMove.san}`);
            needsSyncRetry = false; 
            syncRetryCount = 0;
          } catch (e) {
            console.error(`Internal sync error: ${e.message}`);
            return; 
          }
        } else {
          syncRetryCount++;
          if (syncRetryCount > 5) {
             console.log("⚠️ Board completely desynced. Waiting for next clear move.");
             needsSyncRetry = false; 
             syncRetryCount = 0;
          } else {
             needsSyncRetry = true;
          }
          return; 
        }
      } else {
        needsSyncRetry = false;
      }
      
      const currentFen = chess.fen();
      let timeLeftSec = 0;
      
      try {
        const { iAmWhite, myTimeStr } = await page.evaluate(() => {
          const board = document.querySelector('wc-chess-board');
          const flipped = board ? board.classList.contains('flipped') : false;
          const myClock = document.querySelector(".clock-component.clock-bottom .clock-time-monospace");
          return {
            iAmWhite: !flipped,
            myTimeStr: myClock ? myClock.textContent.trim() : null
          };
        });
        
        // NEW: Update global isBotTurn variable
        isBotTurn = (chess.turn() === 'w' && iAmWhite) || (chess.turn() === 'b' && !iAmWhite);
        
        if (myTimeStr) {
          const [min, sec] = myTimeStr.split(":").map(Number);
          timeLeftSec = min * 60 + sec;
        }
      } catch (e) {
        if (!e.message.includes("Execution context was destroyed")) {
          console.error("Turn/Time detection failed:", e.message);
        }
      }
      
      if (isBotTurn) {
        if (chess.isGameOver()) {
          console.log("🏁 Internal state says game is over.");
          return; 
        }
        const maxSearchDepth = 5;
        console.log("FEN:", currentFen);
        console.log(`Analyzing to depth ${maxSearchDepth}...`);
        
        const finalMove = await getBestMove(currentFen, maxSearchDepth);
        console.log("💡 Engine final move:", finalMove);
        
        const legalMovesCount = chess.moves().length;
        const history = chess.history({ verbose: true });
        const plyCount = history.length;
        const lastMove = plyCount > 0 ? history[plyCount - 1] : null;
        
        let isRecapture = false;
        
        if (lastMove && lastMove.flags.includes('c') && finalMove.slice(2, 4) === lastMove.to) {
          isRecapture = true;
        }

        if (timeLeftSec > 0 && timeLeftSec < 20) {
          await randomDelayBiased(50, 150, 4); 
        } else if (timeLeftSec > 0 && timeLeftSec < 60) {
          await randomDelayBiased(100, 800, 4); 
        } else if (legalMovesCount === 1 || isRecapture) {
          await randomDelayBiased(100, 800, 4);
        } else if (legalMovesCount <= 3) {
          await randomDelayBiased(500, 2000, 2);
        }
        else {
          if (numPieces >= 31) {
            await randomDelayBiased(200, 2000, 4); 
          } else if (numPieces >= 27) {
            await randomDelayBiased(500, 8000, 2); 
          }
           else if (numPieces >= 14) {
            await randomDelayBiased(500, 8000, 0.8); 
          }  else if (numPieces >= 5) {
            await randomDelayBiased(500, 3000, 2); 
          } 
          else {
            await randomDelayBiased(200, 1000, 4); 
          }
        }
        
        const isWhiteToMove = chess.turn() === 'w';
        try {
          await makeMove(page, finalMove, isWhiteToMove);
          chess.move({
              from: finalMove.slice(0, 2),
              to: finalMove.slice(2, 4),
              promotion: finalMove.length === 5 ? finalMove[4] : undefined
          });
          needsSyncRetry = false; 
        } catch (err) {
          console.log(`⚠️ Move physical click failed: ${err.message}. Retrying...`);
          needsSyncRetry = true; 
        }
      }
    } catch (err) {
      if (!err.message.includes("Execution context was destroyed")) {
        console.error("Error reading board:", err.message);
      }
    } finally {
      handlingBoard = false;
    }
  }

  await page.evaluate(() => {
    const board = document.querySelector("wc-chess-board.board");
    if (!board) throw new Error("Board not found");
    window.boardChanged = 0;
    let debounceTimeout = null;
    const observer = new MutationObserver(() => {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        window.boardChanged += 1;
      }, 30); 
    });
    observer.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
    window.mutationObserverAttached = true;
  });
  console.log("✅ MutationObserver attached. Waiting for board changes...");
  
  // MAIN POLLING LOOP
  setInterval(async () => {
    try {
      const changed = await page.evaluate(() => {
        if (window.boardChanged > 0) {
          window.boardChanged = 0;
          return true;
        }
        return false;
      });
      
      if (changed || needsSyncRetry) {
        await handleBoardChange();
      } 
      // NEW: Fidget logic perfectly tucked into the else block
      else {
        const now = Date.now();
        if (!isBotTurn && !handlingBoard && (now - lastFidgetTime > nextFidgetDelay)) {
          lastFidgetTime = now;
          nextFidgetDelay = 3000 + Math.random() * 2000; 
          await humanFidget(page).catch(e => console.log("Fidget skipped:", e.message));
        }
      }
    } catch (e) {
      if (!e.message.includes("Execution context was destroyed")) {
        console.error("Polling error:", e);
      }
    }
  }, 40);
  
  setInterval(async () => {
    try {
      const newGameBtnSelector = '[data-cy="game-over-modal-new-game-button"]';
      const btnVisible = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;
        const style = window.getComputedStyle(btn);
        return style.display !== 'none' && style.visibility !== 'hidden' && btn.offsetHeight > 0;
      }, newGameBtnSelector);
      
      if (btnVisible) {
        console.log("🏁 Game Over detected! Taking a breath before next game...");
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000)); 
        const btnStillExists = await page.$(newGameBtnSelector);
        if (btnStillExists) {
          await page.click(newGameBtnSelector);
          console.log("🔄 Clicked New Game! Waiting for opponent...");
        }
      }
    } catch (e) {
      if (!e.message.includes("Execution context was destroyed")) {
        console.error("Auto-queue error:", e.message);
      }
    }
  }, 2000); 
  
  page.on("framenavigated", async () => {
    console.log("Page navigated, reattaching MutationObserver...");
    try {
      await page.waitForSelector(".piece", { timeout: 20000 });
      await page.waitForSelector("svg.arrows", { timeout: 10000 });
      await page.evaluate(() => {
        const board = document.querySelector("wc-chess-board.board");
        if (!board) return;
        window.boardChanged = 0;
        let debounceTimeout = null;
        const observer = new MutationObserver(() => {
          if (debounceTimeout) clearTimeout(debounceTimeout);
          debounceTimeout = setTimeout(() => {
            window.boardChanged += 1;
          }, 30);
        });
        observer.observe(board, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"]
        });
      });
      console.log("✅ MutationObserver reattached after navigation.");
    } catch (err) {
      console.log("Could not reattach observer:", err.message);
    }
  });
})();
