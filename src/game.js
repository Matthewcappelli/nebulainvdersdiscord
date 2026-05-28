const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#startButton");
const scoreEl = document.querySelector("#score");
const waveEl = document.querySelector("#wave");
const livesEl = document.querySelector("#lives");
const bestEl = document.querySelector("#best");
const touchKeys = document.querySelectorAll(".touch-key");

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const keys = new Set();
const petals = Array.from({ length: 130 }, () => makePetal(true));

let state;
let lastTime = 0;
let best = Number(localStorage.getItem("sakuraInvadersBest") || 0);
bestEl.textContent = best;

function makePetal(randomY = false) {
  return {
    x: Math.random() * WIDTH,
    y: randomY ? Math.random() * HEIGHT : -20,
    size: Math.random() * 5 + 3,
    speed: Math.random() * 34 + 20,
    drift: Math.random() * 34 + 16,
    sway: Math.random() * Math.PI * 2,
    spin: Math.random() * Math.PI
  };
}

function reset() {
  state = {
    running: true,
    paused: false,
    gameOver: false,
    score: 0,
    wave: 1,
    lives: 3,
    invaderDir: 1,
    invaderStepDown: 26,
    shootTimer: 0,
    player: { x: WIDTH / 2 - 30, y: HEIGHT - 72, w: 60, h: 24, cooldown: 0 },
    bullets: [],
    enemyBullets: [],
    particles: [],
    invaders: makeWave(1),
    bunkers: makeBunkers()
  };
  updateHud();
  overlay.classList.add("hidden");
}

function makeWave(wave) {
  const rows = Math.min(3 + wave, 6);
  const cols = 10;
  const gapX = 58;
  const gapY = 42;
  const startX = (WIDTH - (cols - 1) * gapX) / 2 - 20;
  return Array.from({ length: rows * cols }, (_, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return {
      x: startX + col * gapX,
      y: 78 + row * gapY,
      w: 38,
      h: 26,
      row,
      alive: true,
      wobble: Math.random() * Math.PI * 2
    };
  });
}

function makeBunkers() {
  return [172, 372, 572, 772].map((x) => ({ x, y: HEIGHT - 178, w: 104, h: 44, hp: 9 }));
}

function updateHud() {
  scoreEl.textContent = state.score;
  waveEl.textContent = state.wave;
  livesEl.textContent = state.lives;
  bestEl.textContent = best;
}

function rectsHit(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function spawnBurst(x, y, color, count = 14) {
  for (let i = 0; i < count; i += 1) {
    state.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 220,
      vy: (Math.random() - 0.5) * 220,
      life: Math.random() * 0.5 + 0.35,
      color,
      size: Math.random() * 4 + 3
    });
  }
}

function firePlayer() {
  if (!state?.running || state.paused || state.gameOver) return;
  const player = state.player;
  if (player.cooldown > 0) return;
  state.bullets.push({ x: player.x + player.w / 2 - 4, y: player.y - 18, w: 8, h: 20, vy: -540 });
  player.cooldown = 0.22;
}

function enemyFire() {
  const living = state.invaders.filter((invader) => invader.alive);
  if (!living.length) return;
  const shooter = living[Math.floor(Math.random() * living.length)];
  state.enemyBullets.push({ x: shooter.x + shooter.w / 2 - 5, y: shooter.y + shooter.h, w: 10, h: 16, vy: 190 + state.wave * 22 });
}

function update(dt) {
  updatePetals(dt);
  if (!state || !state.running || state.paused || state.gameOver) return;

  const player = state.player;
  const speed = 330;
  if (keys.has("arrowleft") || keys.has("a")) player.x -= speed * dt;
  if (keys.has("arrowright") || keys.has("d")) player.x += speed * dt;
  player.x = Math.max(16, Math.min(WIDTH - player.w - 16, player.x));
  player.cooldown = Math.max(0, player.cooldown - dt);
  if (keys.has(" ")) firePlayer();

  let edgeHit = false;
  const invaderSpeed = 38 + state.wave * 10;
  state.invaders.forEach((invader) => {
    if (!invader.alive) return;
    invader.x += invaderSpeed * state.invaderDir * dt;
    invader.wobble += dt * 5;
    if (invader.x < 18 || invader.x + invader.w > WIDTH - 18) edgeHit = true;
  });

  if (edgeHit) {
    state.invaderDir *= -1;
    state.invaders.forEach((invader) => {
      invader.y += state.invaderStepDown;
    });
  }

  state.shootTimer -= dt;
  if (state.shootTimer <= 0) {
    enemyFire();
    state.shootTimer = Math.max(0.35, 1.4 - state.wave * 0.1 - Math.random() * 0.45);
  }

  moveBullets(dt);
  resolveCollisions();
  updateParticles(dt);

  if (state.invaders.every((invader) => !invader.alive)) {
    state.wave += 1;
    state.invaderDir = 1;
    state.bullets = [];
    state.enemyBullets = [];
    state.invaders = makeWave(state.wave);
    state.score += 250;
    updateHud();
  }

  const breach = state.invaders.some((invader) => invader.alive && invader.y + invader.h >= player.y - 12);
  if (breach) endGame();
}

function updatePetals(dt) {
  petals.forEach((petal, index) => {
    petal.sway += dt * 1.8;
    petal.spin += dt * 2.4;
    petal.x += Math.sin(petal.sway) * petal.drift * dt;
    petal.y += petal.speed * dt;
    if (petal.y > HEIGHT + 24 || petal.x < -30 || petal.x > WIDTH + 30) {
      petals[index] = makePetal(false);
    }
  });
}

function moveBullets(dt) {
  state.bullets.forEach((bullet) => {
    bullet.y += bullet.vy * dt;
  });
  state.enemyBullets.forEach((bullet) => {
    bullet.y += bullet.vy * dt;
  });
  state.bullets = state.bullets.filter((bullet) => bullet.y + bullet.h > 0);
  state.enemyBullets = state.enemyBullets.filter((bullet) => bullet.y < HEIGHT + 20);
}

function resolveCollisions() {
  for (const bullet of state.bullets) {
    for (const invader of state.invaders) {
      if (!invader.alive || !rectsHit(bullet, invader)) continue;
      invader.alive = false;
      bullet.dead = true;
      state.score += 20 + invader.row * 10;
      spawnBurst(invader.x + invader.w / 2, invader.y + invader.h / 2, "#ffb3d2");
      updateHud();
      break;
    }
  }

  for (const bullet of state.enemyBullets) {
    if (rectsHit(bullet, state.player)) {
      bullet.dead = true;
      state.lives -= 1;
      spawnBurst(state.player.x + state.player.w / 2, state.player.y, "#ff6f91", 22);
      updateHud();
      if (state.lives <= 0) endGame();
    }
  }

  for (const bunker of state.bunkers) {
    if (bunker.hp <= 0) continue;
    for (const bullet of [...state.bullets, ...state.enemyBullets]) {
      if (bullet.dead || !rectsHit(bullet, bunker)) continue;
      bullet.dead = true;
      bunker.hp -= 1;
      spawnBurst(bullet.x, bullet.y, "#f8d27a", 5);
    }
  }

  state.bullets = state.bullets.filter((bullet) => !bullet.dead);
  state.enemyBullets = state.enemyBullets.filter((bullet) => !bullet.dead);
}

function updateParticles(dt) {
  state.particles.forEach((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.life -= dt;
    particle.vx *= 0.98;
    particle.vy *= 0.98;
  });
  state.particles = state.particles.filter((particle) => particle.life > 0);
}

function endGame() {
  state.gameOver = true;
  state.running = false;
  if (state.score > best) {
    best = state.score;
    localStorage.setItem("sakuraInvadersBest", String(best));
  }
  updateHud();
  overlay.querySelector("h1").textContent = "Garden overrun";
  overlay.querySelector("p").textContent = `Score ${state.score}. Wave ${state.wave}.`;
  startButton.textContent = "Play Again";
  overlay.classList.remove("hidden");
}

function draw() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  drawBackground();
  drawBunkers();
  drawPlayer();
  drawInvaders();
  drawBullets();
  drawParticles();

  if (state?.paused) {
    ctx.fillStyle = "rgba(33, 14, 30, 0.66)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "#fff7fb";
    ctx.font = "900 64px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Paused", WIDTH / 2, HEIGHT / 2);
  }
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, "#201428");
  gradient.addColorStop(0.52, "#3d1d35");
  gradient.addColorStop(1, "#181827");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "rgba(255, 230, 184, 0.88)";
  ctx.beginPath();
  ctx.arc(WIDTH - 130, 102, 46, 0, Math.PI * 2);
  ctx.fill();

  drawBranch(0, 92, 210, 42, 18);
  drawBranch(WIDTH, 154, WIDTH - 250, 84, 16);

  petals.forEach((petal) => drawPetal(petal.x, petal.y, petal.size, petal.spin, "rgba(255, 190, 217, 0.76)"));
}

function drawBranch(x1, y1, x2, y2, width) {
  ctx.save();
  ctx.strokeStyle = "#6d354a";
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo((x1 + x2) / 2, y1 - 16, x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawPetal(x, y, size, rotation, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.72, size * 1.2, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer() {
  if (!state) return;
  const p = state.player;
  ctx.fillStyle = "#ffb3d2";
  ctx.beginPath();
  ctx.moveTo(p.x + p.w / 2, p.y - 20);
  ctx.lineTo(p.x + p.w, p.y + p.h);
  ctx.lineTo(p.x, p.y + p.h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#fff7fb";
  ctx.fillRect(p.x + 19, p.y + 5, 22, 7);
  ctx.fillStyle = "#f8d27a";
  ctx.fillRect(p.x + 27, p.y - 5, 6, 12);
}

function drawInvaders() {
  if (!state) return;
  state.invaders.forEach((invader) => {
    if (!invader.alive) return;
    const pulse = Math.sin(invader.wobble) * 2;
    const bodyColor = invader.row % 2 ? "#ff8fb8" : "#f8d27a";
    const wingColor = invader.row % 2 ? "#ffd1e3" : "#ffe8aa";
    drawPetal(invader.x + 7, invader.y + 12 + pulse, 8, -0.8, wingColor);
    drawPetal(invader.x + invader.w - 7, invader.y + 12 + pulse, 8, 0.8, wingColor);
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.roundRect(invader.x + 8, invader.y + pulse, invader.w - 16, invader.h, 9);
    ctx.fill();
    ctx.fillStyle = "#2b1220";
    ctx.fillRect(invader.x + 14, invader.y + 10 + pulse, 5, 5);
    ctx.fillRect(invader.x + invader.w - 19, invader.y + 10 + pulse, 5, 5);
  });
}

function drawBunkers() {
  if (!state) return;
  state.bunkers.forEach((bunker) => {
    if (bunker.hp <= 0) return;
    ctx.globalAlpha = 0.3 + bunker.hp / 12;
    ctx.fillStyle = "#7dd3b0";
    ctx.fillRect(bunker.x, bunker.y + 18, bunker.w, bunker.h - 18);
    ctx.fillStyle = "#ffb3d2";
    ctx.fillRect(bunker.x + 12, bunker.y + 8, bunker.w - 24, 18);
    ctx.clearRect(bunker.x + 38, bunker.y + 30, 28, 16);
    ctx.globalAlpha = 1;
  });
}

function drawBullets() {
  if (!state) return;
  state.bullets.forEach((bullet) => drawPetal(bullet.x + bullet.w / 2, bullet.y + bullet.h / 2, 7, -0.25, "#fff0f6"));
  ctx.fillStyle = "#ff6f91";
  state.enemyBullets.forEach((bullet) => {
    ctx.beginPath();
    ctx.ellipse(bullet.x + bullet.w / 2, bullet.y + bullet.h / 2, bullet.w / 2, bullet.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawParticles() {
  if (!state) return;
  state.particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life * 1.8);
    drawPetal(particle.x, particle.y, particle.size, particle.life * 8, particle.color);
  });
  ctx.globalAlpha = 1;
}

function loop(time) {
  const dt = Math.min(0.033, (time - lastTime) / 1000 || 0);
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

startButton.addEventListener("click", () => {
  overlay.querySelector("h1").textContent = "Guard the grove.";
  overlay.querySelector("p").textContent = "Drift through blossom waves, send petal shots, and protect the moonlit garden.";
  startButton.textContent = "Start Game";
  reset();
});

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ([" ", "arrowleft", "arrowright", "a", "d", "p"].includes(key)) event.preventDefault();
  if (key === "p" && state?.running) state.paused = !state.paused;
  keys.add(key);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

touchKeys.forEach((button) => {
  const key = button.dataset.key;
  const press = (event) => {
    event.preventDefault();
    keys.add(key);
    if (key === " ") firePlayer();
  };
  const release = (event) => {
    event.preventDefault();
    keys.delete(key);
  };
  button.addEventListener("pointerdown", press);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("pointerleave", release);
});

draw();
requestAnimationFrame(loop);
