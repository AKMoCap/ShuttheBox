// stb.js   (complete, working file)
document.addEventListener("DOMContentLoaded", () => {
  /* ───────── Firebase + DOM shortcuts ───────── */
  const db = window.db;

  // New Firebase structure for stats
  const freeplayRef = db.ref("freeplay");
  const perpplayRef = db.ref("perpplay");

  // Game session tracking for PerpPlay
  let currentGameVolume = 0;
  let currentGamePnl = 0;

  /* ───────── PerpPlay Mode State ───────── */
  let playMode = 'free'; // 'free' or 'perpplay'
  let walletConnected = false;
  let pendingTrade = false; // prevent multiple trades at once
  let selectedCollateral = 10; // default $10
  let pnlUpdateInterval = null; // interval for live P&L updates

  // PerpPlay UI elements
  const freePlayBtn = document.getElementById('freePlayBtn');
  const perpPlayBtn = document.getElementById('perpPlayBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const walletAddressEl = document.getElementById('walletAddress');
  const walletModal = document.getElementById('walletModal');
  const connectMetamaskBtn = document.getElementById('connectMetamask');
  const connectRabbyBtn = document.getElementById('connectRabby');
  const closeWalletModalBtn = document.getElementById('closeWalletModal');
  const collateralSection = document.getElementById('collateralSection');
  const collateralBtns = document.querySelectorAll('.collateral-btn');
  let connectedWalletAddress = null;

  // Signature hint element
  const signatureHint = document.getElementById('signatureHint');

  // Balance display element
  const userBalanceDisplay = document.getElementById('userBalanceDisplay');
  let balanceUpdateInterval = null;
  let currentUserBalance = 0;

  // Trade toast elements
  const tradeToast = document.getElementById('tradeToast');
  const tradeToastText = document.getElementById('tradeToastText');

  // Position table elements
  const positionTableContainer = document.getElementById('positionTableContainer');
  const positionTableBody = document.getElementById('positionTableBody');
  const positionTableFooter = document.getElementById('positionTableFooter');
  const totalPnlEl = document.getElementById('totalPnl');
  const noPositionsMsg = document.getElementById('noPositionsMsg');
  const endGameBtn = document.getElementById('endGameBtn');

  // Closing overlay elements
  const closingOverlay = document.getElementById('closingOverlay');
  const closingTitle = document.getElementById('closingTitle');
  const closingProgress = document.getElementById('closingProgress');

  // End game modal elements
  const endGameModal = document.getElementById('endGameModal');
  const endGameTitle = document.getElementById('endGameTitle');
  const endGameSubtitle = document.getElementById('endGameSubtitle');
  const endGamePositionsList = document.getElementById('endGamePositionsList');
  const endGameTotalPnl = document.getElementById('endGameTotalPnl');
  const closeAllPositionsBtn = document.getElementById('closeAllPositionsBtn');
  const keepSelectedBtn = document.getElementById('keepSelectedBtn');

  // Track positions to keep for next game
  let positionsToKeep = [];
  // Track if end game modal was triggered by game end (requires stats recording)
  let endGameModalContext = { recordStats: false, won: false };
  // Flag to skip position clearing on next startGame call (when keeping positions)
  let skipPositionClear = false;

  /* ───────── PerpPlay Mode Functions ───────── */
  function truncateAddress(address) {
    if (!address) return '';
    return `Wallet: ${address.slice(0, 6)}....${address.slice(-4)}`;
  }

  function updateModeButtons() {
    if (playMode === 'free') {
      freePlayBtn.classList.add('active');
      perpPlayBtn.classList.remove('active');
      perpPlayBtn.classList.remove('connected');
      perpPlayBtn.textContent = 'PerpPlay - Connect Wallet';
      disconnectBtn.style.display = 'none';
      if (collateralSection) collateralSection.style.display = 'none';
      if (walletAddressEl) walletAddressEl.style.display = 'none';
      if (signatureHint) signatureHint.style.display = 'none';
      if (positionTableContainer) positionTableContainer.style.display = 'none';
      stopPnlUpdates();
      stopBalanceUpdates();
    } else {
      freePlayBtn.classList.remove('active');
      perpPlayBtn.classList.add('active');
      if (walletConnected) {
        perpPlayBtn.classList.add('connected');
        perpPlayBtn.textContent = 'Connected - PerpPlay';
        disconnectBtn.style.display = 'inline-block';
        if (collateralSection) collateralSection.style.display = 'block';
        if (walletAddressEl && connectedWalletAddress) {
          walletAddressEl.textContent = truncateAddress(connectedWalletAddress);
          walletAddressEl.style.display = 'block';
        }
        if (signatureHint) signatureHint.style.display = 'none';
        if (positionTableContainer) positionTableContainer.style.display = 'block';
        startPnlUpdates();
        startBalanceUpdates();
      } else {
        // Not connected yet - show signature hint
        if (signatureHint) signatureHint.style.display = 'block';
        if (walletAddressEl) walletAddressEl.style.display = 'none';
      }
    }
  }

  function showWalletModal() {
    walletModal.style.display = 'flex';
  }

  function hideWalletModal() {
    walletModal.style.display = 'none';
  }

  async function connectWallet(walletType) {
    hideWalletModal();

    if (!window.HyperliquidManager) {
      alert('Hyperliquid integration not loaded. Please refresh the page.');
      return;
    }

    perpPlayBtn.textContent = 'Connecting...';

    const result = await window.HyperliquidManager.connectWallet(walletType);

    if (result.success) {
      walletConnected = true;
      connectedWalletAddress = result.address;
      playMode = 'perpplay';
      updateModeButtons();

      console.log('PerpPlay mode activated for wallet:', result.address);
    } else {
      alert('Wallet connection failed: ' + result.error);
      perpPlayBtn.textContent = 'PerpPlay - Connect Wallet';
    }
  }

  function disconnectWallet() {
    if (window.HyperliquidManager) {
      window.HyperliquidManager.disconnectWallet();
    }
    walletConnected = false;
    connectedWalletAddress = null;
    playMode = 'free';
    updateModeButtons();
  }

  // Trade toast functions
  function showTradeToast(token, leverage, side, collateral) {
    if (tradeToastText) {
      tradeToastText.textContent = `Opening ${token} ${leverage}x ${side} with $${collateral}...`;
    }
    if (tradeToast) {
      tradeToast.style.display = 'block';
      tradeToast.classList.remove('error');
    }
  }

  function showErrorToast(message) {
    if (tradeToastText) {
      tradeToastText.textContent = message;
    }
    if (tradeToast) {
      tradeToast.style.display = 'block';
      tradeToast.classList.add('error');
    }
    // Auto-hide error toast after 3 seconds
    setTimeout(hideTradeToast, 3000);
  }

  function hideTradeToast() {
    if (tradeToast) {
      tradeToast.style.display = 'none';
      tradeToast.classList.remove('error');
    }
  }

  // Position table functions
  async function updatePositionTable() {
    if (!window.HyperliquidManager || playMode !== 'perpplay') return;

    try {
      const positions = await window.HyperliquidManager.getGamePositionsWithPnL();

      if (!positionTableBody) return;

      // Clear existing rows
      positionTableBody.innerHTML = '';

      if (positions.length === 0) {
        if (noPositionsMsg) noPositionsMsg.style.display = 'block';
        if (positionTableFooter) positionTableFooter.style.display = 'none';
        return;
      }

      if (noPositionsMsg) noPositionsMsg.style.display = 'none';

      let totalPnl = 0;

      positions.forEach(pos => {
        const row = document.createElement('tr');

        const pnlValue = pos.pnlUsd || 0;
        totalPnl += pnlValue;
        const pnlClass = pnlValue >= 0 ? 'profit' : 'loss';
        const pnlSign = pnlValue >= 0 ? '+' : '';

        row.innerHTML = `
          <td>${pos.tokenName}</td>
          <td class="${pos.side.toLowerCase()}">${pos.side}</td>
          <td>${pos.leverage}x</td>
          <td>$${pos.collateral}</td>
          <td class="${pnlClass}">${pnlSign}$${pnlValue.toFixed(2)}</td>
        `;

        positionTableBody.appendChild(row);
      });

      // Update total P&L footer
      if (positionTableFooter) positionTableFooter.style.display = 'table-footer-group';
      if (totalPnlEl) {
        const totalPnlClass = totalPnl >= 0 ? 'profit' : 'loss';
        const totalPnlSign = totalPnl >= 0 ? '+' : '';
        totalPnlEl.textContent = `${totalPnlSign}$${totalPnl.toFixed(2)}`;
        totalPnlEl.className = `total-pnl ${totalPnlClass}`;
      }
    } catch (error) {
      console.error('Error updating position table:', error);
    }
  }

  function startPnlUpdates() {
    if (pnlUpdateInterval) return; // Already running
    updatePositionTable(); // Initial update
    pnlUpdateInterval = setInterval(updatePositionTable, 2000); // Update every 2 seconds
  }

  function stopPnlUpdates() {
    if (pnlUpdateInterval) {
      clearInterval(pnlUpdateInterval);
      pnlUpdateInterval = null;
    }
  }

  // Balance update functions
  async function updateUserBalance() {
    if (!window.HyperliquidManager || playMode !== 'perpplay' || !walletConnected) return;

    try {
      const balance = await window.HyperliquidManager.getUserBalance();
      if (balance && userBalanceDisplay) {
        currentUserBalance = balance.available;
        userBalanceDisplay.textContent = `$${balance.available.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
    } catch (error) {
      console.error('Error updating balance:', error);
    }
  }

  function startBalanceUpdates() {
    if (balanceUpdateInterval) return;
    updateUserBalance(); // Initial update
    balanceUpdateInterval = setInterval(updateUserBalance, 5000); // Update every 5 seconds
  }

  function stopBalanceUpdates() {
    if (balanceUpdateInterval) {
      clearInterval(balanceUpdateInterval);
      balanceUpdateInterval = null;
    }
    if (userBalanceDisplay) {
      userBalanceDisplay.textContent = '$0.00';
    }
    currentUserBalance = 0;
  }

  // Show end game modal with position checkboxes
  async function showEndGameModal(title = 'Game Over!', isWin = false) {
    if (!window.HyperliquidManager) return false;

    // Wait 1.5 seconds to ensure all positions are opened
    await new Promise(resolve => setTimeout(resolve, 1500));

    const positions = await window.HyperliquidManager.getGamePositionsWithPnL();
    if (positions.length === 0) {
      return false; // No positions to show
    }

    // Set modal title
    if (endGameTitle) endGameTitle.textContent = title;
    if (endGameSubtitle) {
      endGameSubtitle.textContent = isWin
        ? 'Congrats! Choose which positions to close:'
        : 'Choose which positions to close:';
    }

    // Build positions list with checkboxes
    if (endGamePositionsList) {
      endGamePositionsList.innerHTML = '';
      let totalPnl = 0;

      positions.forEach((pos, index) => {
        const pnl = pos.pnlUsd || 0;
        totalPnl += pnl;

        const item = document.createElement('div');
        item.className = 'end-game-position-item';

        // Use tokenName for display (pos.token is the full object)
        const tokenName = pos.tokenName || pos.token?.name || 'Unknown';
        const sideClass = pos.side === 'LONG' ? 'position-side-long' : 'position-side-short';
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';
        const pnlSign = pnl >= 0 ? '+' : '';

        item.innerHTML = `
          <label>
            <input type="checkbox" checked data-index="${index}" data-token="${tokenName}">
            <div class="position-info">
              <span class="position-token">${tokenName}</span>
              <span class="position-details">
                <span class="${sideClass}">${pos.side}</span> ${pos.leverage}x | $${pos.collateral?.toFixed(2) || '0.00'}
              </span>
            </div>
          </label>
          <span class="position-pnl ${pnlClass}">${pnlSign}$${pnl.toFixed(2)}</span>
        `;
        endGamePositionsList.appendChild(item);
      });

      // Update total P&L
      if (endGameTotalPnl) {
        const pnlClass = totalPnl >= 0 ? 'positive' : 'negative';
        const pnlSign = totalPnl >= 0 ? '+' : '';
        endGameTotalPnl.textContent = `${pnlSign}$${totalPnl.toFixed(2)}`;
        endGameTotalPnl.className = pnlClass;
      }
    }

    // Show modal
    if (endGameModal) endGameModal.style.display = 'flex';
    return true;
  }

  // Hide end game modal
  function hideEndGameModal() {
    if (endGameModal) endGameModal.style.display = 'none';
  }

  // Close selected positions (checked ones)
  async function closeSelectedPositions(recordStats = false, won = false) {
    if (!window.HyperliquidManager) return;

    // Get checked checkboxes
    const checkboxes = endGamePositionsList?.querySelectorAll('input[type="checkbox"]:checked') || [];
    const indicesToClose = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));

    const positions = await window.HyperliquidManager.getGamePositionsWithPnL();

    // Get positions to close and positions to keep
    const toClose = positions.filter((_, i) => indicesToClose.includes(i));
    positionsToKeep = positions.filter((_, i) => !indicesToClose.includes(i));

    hideEndGameModal();

    if (toClose.length === 0) {
      // Nothing to close, just start new game with kept positions
      window.HyperliquidManager.clearGamePositions();
      // Re-add kept positions
      positionsToKeep.forEach(pos => {
        window.HyperliquidManager.gamePositions.push(pos);
      });
      if (recordStats) {
        const totalPnl = positions.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
        await recordPerpPlayResult(won, currentGameVolume, totalPnl);
        currentGameVolume = 0;
        currentGamePnl = 0;
      }
      // Skip clearing positions in startGame since we're keeping some
      skipPositionClear = positionsToKeep.length > 0;
      startGame();
      updatePositionTable();
      return;
    }

    // Show closing overlay
    if (closingOverlay) closingOverlay.style.display = 'flex';
    if (closingTitle) closingTitle.textContent = 'Closing Positions...';
    if (closingProgress) closingProgress.textContent = '';

    let closedPnl = 0;
    try {
      // Close selected positions one by one
      for (let i = 0; i < toClose.length; i++) {
        const pos = toClose[i];
        const tokenName = pos.tokenName || pos.token?.name || 'Unknown';
        if (closingProgress) {
          closingProgress.textContent = `Closing ${i + 1}/${toClose.length}: ${tokenName}`;
        }
        const result = await window.HyperliquidManager.closePosition(pos);
        if (result.success) {
          closedPnl += (result.pnlUsd || 0);
        }
      }

      // Clear all game positions
      window.HyperliquidManager.clearGamePositions();
      // Re-add kept positions
      positionsToKeep.forEach(pos => {
        window.HyperliquidManager.gamePositions.push(pos);
      });

      const keptCount = positionsToKeep.length;
      if (closingTitle) {
        const pnlSign = closedPnl >= 0 ? '+' : '';
        closingTitle.textContent = keptCount > 0
          ? `Closed P&L: ${pnlSign}$${closedPnl.toFixed(2)} | Keeping ${keptCount} position${keptCount > 1 ? 's' : ''}`
          : `Final P&L: ${pnlSign}$${closedPnl.toFixed(2)}`;
      }
      if (closingProgress) closingProgress.textContent = 'Done!';

      // Record stats if needed
      if (recordStats) {
        const totalPnl = positions.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
        await recordPerpPlayResult(won, currentGameVolume, totalPnl);
        currentGameVolume = 0;
        currentGamePnl = 0;
      }

      // Hide overlay and restart
      setTimeout(() => {
        if (closingOverlay) closingOverlay.style.display = 'none';
        // Skip clearing positions in startGame if we're keeping some
        skipPositionClear = positionsToKeep.length > 0;
        startGame();
        updatePositionTable();
      }, 2000);

    } catch (error) {
      console.error('Error closing positions:', error);
      if (closingTitle) closingTitle.textContent = 'Error closing positions';
      if (closingProgress) closingProgress.textContent = error.message;
      setTimeout(() => {
        if (closingOverlay) closingOverlay.style.display = 'none';
      }, 3000);
    }
  }

  // Handle end game button click - show modal instead of immediate close
  async function handleEndGame() {
    if (!window.HyperliquidManager) return;

    // End Game button doesn't record stats (manual end)
    endGameModalContext = { recordStats: false, won: false };

    const hasPositions = await showEndGameModal('End Game', false);
    if (!hasPositions) {
      // No positions, just restart
      startGame();
    }
    // If positions exist, modal is now showing and user will choose
  }

  // Execute PerpPlay trade
  async function executePerpPlayTrade() {
    if (!walletConnected || playMode !== 'perpplay' || pendingTrade) {
      return;
    }

    if (!window.HyperliquidManager) {
      console.error('HyperliquidManager not available');
      return;
    }

    pendingTrade = true;

    try {
      // Check if user has enough balance first
      const balance = await window.HyperliquidManager.getUserBalance();
      if (!balance || balance.available < selectedCollateral) {
        console.log(`Insufficient balance: $${balance?.available || 0} < $${selectedCollateral}`);
        showErrorToast('Not enough collateral to open a new position!');
        pendingTrade = false;
        return;
      }

      // Get random token and side first for the toast
      const token = await window.HyperliquidManager.getRandomTopToken();
      if (!token) {
        console.error('No token available');
        pendingTrade = false;
        return;
      }

      // 75% Long, 25% Short
      const side = Math.random() < 0.75 ? 'LONG' : 'SHORT';
      const leverage = Math.min(token.maxLeverage || 20, 20);

      // Show toast with token name
      showTradeToast(token.name, leverage, side, selectedCollateral);

      // Open the position
      const result = await window.HyperliquidManager.openPosition(token, selectedCollateral, side);

      // Hide toast after position opens (success or fail)
      hideTradeToast();

      if (result.success) {
        console.log(`Position opened: ${token.name} ${side} with $${selectedCollateral}`);
        // Track volume for stats
        trackPositionOpened(selectedCollateral);
        // Update position table and balance immediately
        await updatePositionTable();
        await updateUserBalance();
      } else {
        console.error('Trade failed:', result.error);
        showErrorToast('Trade failed: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Trade execution error:', error);
      hideTradeToast();
    }

    pendingTrade = false;
  }

  // Event listeners for PerpPlay mode
  if (freePlayBtn) {
    freePlayBtn.addEventListener('click', () => {
      playMode = 'free';
      updateModeButtons();
    });
  }

  if (perpPlayBtn) {
    perpPlayBtn.addEventListener('click', () => {
      if (walletConnected) {
        // Already connected, just switch mode
        playMode = 'perpplay';
        updateModeButtons();
      } else {
        // Show wallet connection modal
        showWalletModal();
      }
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', disconnectWallet);
  }

  if (connectMetamaskBtn) {
    connectMetamaskBtn.addEventListener('click', () => connectWallet('metamask'));
  }

  if (connectRabbyBtn) {
    connectRabbyBtn.addEventListener('click', () => connectWallet('rabby'));
  }

  if (closeWalletModalBtn) {
    closeWalletModalBtn.addEventListener('click', hideWalletModal);
  }

  // Close modal when clicking outside
  if (walletModal) {
    walletModal.addEventListener('click', (e) => {
      if (e.target === walletModal) {
        hideWalletModal();
      }
    });
  }

  // Collateral button selection
  collateralBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      collateralBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCollateral = parseInt(btn.dataset.amount, 10);
      console.log('Collateral selected:', selectedCollateral);
    });
  });

  // End Game button handler
  if (endGameBtn) {
    endGameBtn.addEventListener('click', handleEndGame);
  }

  // End Game Modal button handlers
  if (closeAllPositionsBtn) {
    closeAllPositionsBtn.addEventListener('click', () => {
      // Check all checkboxes and close all
      const checkboxes = endGamePositionsList?.querySelectorAll('input[type="checkbox"]') || [];
      checkboxes.forEach(cb => cb.checked = true);
      closeSelectedPositions(endGameModalContext.recordStats, endGameModalContext.won);
    });
  }

  if (keepSelectedBtn) {
    keepSelectedBtn.addEventListener('click', () => {
      // Close only checked positions, keep unchecked ones
      closeSelectedPositions(endGameModalContext.recordStats, endGameModalContext.won);
    });
  }

  // Stats Modal Elements
  const statsBtn = document.getElementById('statsBtn');
  const statsModal = document.getElementById('statsModal');
  const closeStatsModal = document.getElementById('closeStatsModal');

  // Stats display elements
  const fpTotalPlayers = document.getElementById('fpTotalPlayers');
  const fpTotalWins = document.getElementById('fpTotalWins');
  const fpTotalLosses = document.getElementById('fpTotalLosses');
  const fpYourWins = document.getElementById('fpYourWins');
  const fpYourLosses = document.getElementById('fpYourLosses');

  const ppTotalWallets = document.getElementById('ppTotalWallets');
  const ppTotalWins = document.getElementById('ppTotalWins');
  const ppTotalLosses = document.getElementById('ppTotalLosses');
  const ppYourWins = document.getElementById('ppYourWins');
  const ppYourLosses = document.getElementById('ppYourLosses');
  const ppYourVolume = document.getElementById('ppYourVolume');
  const ppYourPnl = document.getElementById('ppYourPnl');

  // Local storage for free play personal stats
  let localFpWins = +localStorage.getItem("fpWins") || 0;
  let localFpLosses = +localStorage.getItem("fpLosses") || 0;

  const winSound = new Audio("cheer.mp3");
  const loseSound = new Audio("wompwomp.mp3");
  const airhorn = new Audio("airhorn.mp3"); // ⬅ NEW
  airhorn.preload = "auto";
  airhorn.volume = 0.35;
  airhorn.muted = true; // follows the master toggle
  const koolAid = new Audio("ohyeah.mp3"); // ⬅ NEW
  koolAid.preload = "auto";
  koolAid.volume = 0.35;
  koolAid.muted = true; // follows the master toggle
  const cmon = new Audio("cmonman.mp3"); // ⬅ NEW
  cmon.preload = "auto";
  cmon.volume = 0.35;
  cmon.muted = true; // follows the master toggle
  const nelly = new Audio("nelly.mp3");
  nelly.preload = "auto";
  nelly.volume = 0.35;
  nelly.muted = true; // follows the master toggle
  const silencer = new Audio("silencer.mp3");
  silencer.preload = "auto";
  silencer.volume = 0.35;
  silencer.muted = true; // follows the master toggle
  const chewy = new Audio("chewy.mp3");
  chewy.preload = "auto";
  chewy.volume = 0.35;
  chewy.muted = true; // follows the master toggle
  const lose2 = new Audio("lose2.mp3");
  lose2.preload = "auto";
  lose2.volume = 0.35;
  lose2.muted = true; // follows the master toggle
  const drumroll = new Audio("drumroll.mp3");
  drumroll.preload = "auto";
  drumroll.volume = 0.35;
  drumroll.muted = true; // follows the master toggle

  winSound.volume = loseSound.volume = 0.3;
  winSound.muted = loseSound.muted = true;
  let soundEnabled = false;

  const cvs = document.getElementById("board");
  const ctx = cvs.getContext("2d");
  const remainingEl = document.getElementById("remaining");
  const diceResEl = document.getElementById("diceResult");
  const rollBtn = document.getElementById("rollBtn");
  const restartBtn = document.getElementById("restartBtn");
  const soundToggle = document.getElementById("soundToggle");

  const oddsSpan = document.getElementById("immediateOdds");

  /* one-time browser id for free play */
  let playerId = localStorage.getItem("playerId");
  if (!playerId) {
    playerId = crypto.randomUUID();
    localStorage.setItem("playerId", playerId);
  }

  /* ───────── Stats Functions ───────── */

  // Load and display all stats
  async function loadAllStats() {
    // Free Play Stats
    try {
      const fpPlayersSnap = await freeplayRef.child("players").once("value");
      const fpWinsSnap = await freeplayRef.child("totalWins").once("value");
      const fpLossesSnap = await freeplayRef.child("totalLosses").once("value");

      if (fpTotalPlayers) fpTotalPlayers.textContent = fpPlayersSnap.exists() ? fpPlayersSnap.numChildren() : 0;
      if (fpTotalWins) fpTotalWins.textContent = fpWinsSnap.val() || 0;
      if (fpTotalLosses) fpTotalLosses.textContent = fpLossesSnap.val() || 0;
      if (fpYourWins) fpYourWins.textContent = localFpWins;
      if (fpYourLosses) fpYourLosses.textContent = localFpLosses;
    } catch (error) {
      console.error('Error loading free play stats:', error);
    }

    // PerpPlay Stats
    try {
      const ppWalletsSnap = await perpplayRef.child("wallets").once("value");
      const ppWinsSnap = await perpplayRef.child("totalWins").once("value");
      const ppLossesSnap = await perpplayRef.child("totalLosses").once("value");

      if (ppTotalWallets) ppTotalWallets.textContent = ppWalletsSnap.exists() ? ppWalletsSnap.numChildren() : 0;
      if (ppTotalWins) ppTotalWins.textContent = ppWinsSnap.val() || 0;
      if (ppTotalLosses) ppTotalLosses.textContent = ppLossesSnap.val() || 0;

      // Load wallet-specific stats if connected
      if (connectedWalletAddress) {
        const walletKey = connectedWalletAddress.toLowerCase();
        const walletSnap = await perpplayRef.child(`wallets/${walletKey}`).once("value");
        const walletData = walletSnap.val() || {};

        if (ppYourWins) ppYourWins.textContent = walletData.wins || 0;
        if (ppYourLosses) ppYourLosses.textContent = walletData.losses || 0;
        if (ppYourVolume) ppYourVolume.textContent = `$${(walletData.volume || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        if (ppYourPnl) {
          const pnl = walletData.pnl || 0;
          ppYourPnl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          ppYourPnl.className = pnl >= 0 ? 'profit' : 'loss';
        }
      } else {
        // Not connected - show zeros
        if (ppYourWins) ppYourWins.textContent = '0';
        if (ppYourLosses) ppYourLosses.textContent = '0';
        if (ppYourVolume) ppYourVolume.textContent = '$0.00';
        if (ppYourPnl) {
          ppYourPnl.textContent = '$0.00';
          ppYourPnl.className = '';
        }
      }
    } catch (error) {
      console.error('Error loading perpplay stats:', error);
    }
  }

  // Record Free Play game result
  async function recordFreePlayResult(won) {
    try {
      // Update global stats
      const statRef = won ? freeplayRef.child("totalWins") : freeplayRef.child("totalLosses");
      await statRef.transaction((c) => (c || 0) + 1);

      // Register player
      await freeplayRef.child(`players/${playerId}`).set(true);

      // Update local stats
      if (won) {
        localFpWins++;
        localStorage.setItem("fpWins", localFpWins);
      } else {
        localFpLosses++;
        localStorage.setItem("fpLosses", localFpLosses);
      }
    } catch (error) {
      console.error('Error recording free play result:', error);
    }
  }

  // Record PerpPlay game result
  async function recordPerpPlayResult(won, volume, pnl) {
    if (!connectedWalletAddress) return;

    const walletKey = connectedWalletAddress.toLowerCase();

    try {
      // Update global stats
      const statRef = won ? perpplayRef.child("totalWins") : perpplayRef.child("totalLosses");
      await statRef.transaction((c) => (c || 0) + 1);

      // Update wallet-specific stats
      const walletRef = perpplayRef.child(`wallets/${walletKey}`);

      await walletRef.transaction((data) => {
        if (!data) {
          data = { wins: 0, losses: 0, volume: 0, pnl: 0 };
        }
        if (won) {
          data.wins = (data.wins || 0) + 1;
        } else {
          data.losses = (data.losses || 0) + 1;
        }
        data.volume = (data.volume || 0) + volume;
        data.pnl = (data.pnl || 0) + pnl;
        return data;
      });

      console.log(`PerpPlay result recorded: ${won ? 'WIN' : 'LOSS'}, Volume: $${volume.toFixed(2)}, P&L: $${pnl.toFixed(2)}`);
    } catch (error) {
      console.error('Error recording perpplay result:', error);
    }
  }

  // Record individual position for volume tracking
  function trackPositionOpened(collateral) {
    currentGameVolume += collateral;
    console.log(`Position opened: $${collateral}, Game volume now: $${currentGameVolume}`);
  }

  // Stats Modal handlers
  function showStatsModal() {
    loadAllStats();
    if (statsModal) statsModal.style.display = 'flex';
  }

  function hideStatsModal() {
    if (statsModal) statsModal.style.display = 'none';
  }

  if (statsBtn) {
    statsBtn.addEventListener('click', showStatsModal);
  }

  if (closeStatsModal) {
    closeStatsModal.addEventListener('click', hideStatsModal);
  }

  if (statsModal) {
    statsModal.addEventListener('click', (e) => {
      if (e.target === statsModal) {
        hideStatsModal();
      }
    });
  }

  /* ───────── layout constants ───────── */
  const CARD_W = 90,
    CARD_H = 130,
    GAP = 16,
    COLS = 6,
    ROWS = 2;
  const TOTAL_W = COLS * CARD_W + (COLS - 1) * GAP + 6;
  const TOTAL_H = ROWS * CARD_H + (ROWS - 1) * GAP + 6;
  const START_X = Math.round((cvs.width - TOTAL_W) / 2);
  const START_Y = Math.round((cvs.height - TOTAL_H) / 2) - 70; // shift cards up for roll button and position table

  const SUIT = "♠";
  const FACE = [
    "",
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
  ];
  const TOTAL_START = 78;

  /* ───────── game state ───────── */
  let flipped = new Set(),
    newlyFlipped = new Set();
  let diceTotal = 0,
    awaitingPick = false,
    gameOver = false;
  let drumrollPlayed = false;

  /* desktop cursor (1-based) */
  let cursor = 1;
  const isDesktop = () => window.innerWidth > 800;

  /* ───────── odds helpers ───────── */
  const dist1 = Array.from({ length: 6 }, (_, i) => ({ r: i + 1, p: 1 / 6 }));
  const freqs = {
    2: 1,
    3: 2,
    4: 3,
    5: 4,
    6: 5,
    7: 6,
    8: 5,
    9: 4,
    10: 3,
    11: 2,
    12: 1,
  };
  const dist2 = Object.entries(freqs).map(([r, f]) => ({ r: +r, p: f / 36 }));

  const rollDice = (n) =>
    Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6)).reduce(
      (a, b) => a + b,
      0,
    );
  const updateRemaining = () =>
    (remainingEl.textContent =
      TOTAL_START - [...flipped].reduce((s, v) => s + v, 0));

  function legalCardSet(total) {
    const pool = [...Array(13).keys()].slice(1).filter((v) => !flipped.has(v));
    const ok = new Set(),
      n = pool.length;
    (function dfs(i, need, used) {
      if (!need) {
        used.forEach((v) => ok.add(v));
        return;
      }
      for (let j = i; j < n; j++) {
        if (pool[j] > need) continue;
        dfs(j + 1, need - pool[j], [...used, pool[j]]);
      }
    })(0, total, []);
    return ok;
  }

  function updateImmediateOdds() {
    if (!oddsSpan) return;
    const mode = +document.querySelector('input[name="diceMode"]:checked')
      .value;
    const dist = mode === 1 ? dist1 : dist2;
    let odds = 0;
    for (const { r, p } of dist) {
      if (legalCardSet(r).size) odds += p;
    }
    oddsSpan.textContent = (odds * 100).toFixed(1) + "%";
  }

  /* ───────── drawing ───────── */
  function drawBoard(high = new Set()) {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    for (let v = 1; v <= 12; v++) {
      const idx = v - 1,
        row = idx < 6 ? 0 : 1,
        col = row ? idx - 6 : idx;
      const x = START_X + col * (CARD_W + GAP),
        y = START_Y + row * (CARD_H + GAP);
      const isFlip = flipped.has(v),
        isLegal = high.has(v) && !isFlip;

      ctx.fillStyle = isFlip ? "#3AB4EF" : isLegal ? "#c9ecff" : "#0b1624";
      ctx.strokeStyle = "#3AB4EF";
      ctx.lineWidth = isLegal ? 6 : 3;
      ctx.fillRect(x, y, CARD_W, CARD_H);
      ctx.strokeRect(x, y, CARD_W, CARD_H);

      if (isDesktop() && awaitingPick && v === cursor && !isFlip) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 4;
        ctx.strokeRect(x + 4, y + 4, CARD_W - 8, CARD_H - 8);
      }

      if (!isFlip) {
        ctx.fillStyle = "#3AB4EF";
        ctx.font = "bold 38px 'Franklin Gothic Book', Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${FACE[v]}${SUIT}`, x + CARD_W / 2, y + CARD_H / 2);
      }
    }
    updateImmediateOdds();
  }

  /* ───────── flip helper ───────── */
  function tryToggle(v) {
    if (!awaitingPick) return false;
    if (newlyFlipped.has(v)) {
      newlyFlipped.delete(v);
      flipped.delete(v);
      diceTotal += v;
    } else if (!flipped.has(v) && legalCardSet(diceTotal).has(v)) {
      newlyFlipped.add(v);
      flipped.add(v);
      diceTotal -= v;
    } else return false;

    updateRemaining();
    const next = diceTotal ? legalCardSet(diceTotal) : new Set();
    if (next.size) cursor = [...next][0];
    drawBoard(next);

    if (!diceTotal) {
      awaitingPick = false;
      diceResEl.textContent = "✅ Good move!";
      checkWinLose();

      // Trigger PerpPlay trade if in perpplay mode and wallet connected
      if (playMode === 'perpplay' && walletConnected && !gameOver) {
        executePerpPlayTrade();
      }
    }

    const remainingCards = 12 - flipped.size;
    // play Nelly once when <=3 cards remain
    if (soundEnabled && remainingCards == 3 && !nelly.played?.length) {
      nelly.currentTime = 0;
      nelly.play().catch(() => {});
    }
    // 🔔 NEW: play drum‑roll once when <=2 cards remain
    if (soundEnabled && remainingCards <= 2 && !drumrollPlayed) {
      drumroll.pause();
      drumroll.currentTime = 0;
      drumroll.play().catch(() => {});
      drumrollPlayed = true;
    }

    return true;
  }

  /* ───────── mouse ── ��────── */
  cvs.addEventListener("click", (e) => {
    const r = cvs.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (cvs.width / r.width),
      my = (e.clientY - r.top) * (cvs.height / r.height);
    for (let v = 1; v <= 12; v++) {
      if (!newlyFlipped.has(v) && flipped.has(v)) continue;
      const idx = v - 1,
        row = idx < 6 ? 0 : 1,
        col = row ? idx - 6 : idx;
      const x = START_X + col * (CARD_W + GAP),
        y = START_Y + row * (CARD_H + GAP);
      if (mx > x && mx < x + CARD_W && my > y && my < y + CARD_H) {
        tryToggle(v);
        break;
      }
    }
  });

  /* ───────── rolling helpers ───────── */
  function rollAnimation(mode, cb) {
    let f = 0,
      iv = setInterval(() => {
        diceResEl.textContent = `🎲🎲${1 + Math.floor((Math.random() * mode * 6) / mode)}`;
        if (++f === 12) {
          clearInterval(iv);
          cb();
        }
      }, 85);
  }
  function performRoll() {
    newlyFlipped.clear();
    rollCount++; // 📈 count this roll
    const mode = +document.querySelector('input[name="diceMode"]:checked')
      .value;
    rollAnimation(mode, () => {
      diceTotal = rollDice(mode);
      if (diceTotal === 12 && soundEnabled) {
        airhorn.currentTime = 0; // rewind for re-use
        airhorn.play().catch(() => {
          /* ignore */
        });
      }
      if (diceTotal === 10 && soundEnabled) {
        silencer.currentTime = 0; // rewind for re-use
        silencer.play().catch(() => {
          /* ignore */
        });
      }
      if (diceTotal === 11 && soundEnabled) {
        koolAid.currentTime = 0; // rewind for re-use
        koolAid.play().catch(() => {
          /* ignore */
        });
      }
      if (diceTotal === 2 && soundEnabled) {
        cmon.currentTime = 0; // rewind for re-use
        cmon.play().catch(() => {
          /* ignore */
        });
      }

      diceResEl.textContent = `You rolled ${diceTotal}`;
      const legal = legalCardSet(diceTotal);
      if (!legal.size) {
        stopGame(false);
        return;
      }
      awaitingPick = true;
      cursor = [...legal][0];
      drawBoard(legal);
    });
  }

  rollBtn.addEventListener("click", () => {
    if (gameOver) return;
    if (awaitingPick) {
      alert("First flip cards totalling the previous roll.");
      return;
    }
    performRoll();
  });

  /* ───────── keyboard (desktop) ───────── */
  document.addEventListener("keydown", (e) => {
    if (!isDesktop()) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      restartBtn.click();
      return;
    }
    if (e.key === "Enter" && !awaitingPick && !gameOver) {
      e.preventDefault();
      performRoll();
      return;
    }

    if (!awaitingPick) return;

    const move = (s) => {
      let n = cursor;
      do {
        n += s;
      } while (n >= 1 && n <= 12 && flipped.has(n));
      if (n >= 1 && n <= 12) cursor = n;
      drawBoard(legalCardSet(diceTotal));
    };
    switch (e.key) {
      case "ArrowRight":
        move(+1);
        e.preventDefault();
        break;
      case "ArrowLeft":
        move(-1);
        e.preventDefault();
        break;
      case "ArrowDown":
        move(+6);
        e.preventDefault();
        break;
      case "ArrowUp":
        move(-6);
        e.preventDefault();
        break;
      case " ":
      case "Spacebar":
      case "Space":
      case "Enter":
        e.preventDefault();
        tryToggle(cursor);
        break;
    }
  });

  /* ───────── DEV-ONLY force-win shortcut ───────── 
  function devInstantWin() {
    if (gameOver) return;                // already finished
    for (let v = 1; v <= 12; v++) flipped.add(v);
    updateRemaining();
    drawBoard();
    stopGame(true);                       // triggers confetti + share card
  }

  document.addEventListener('keydown', e => {
    // Alt + W  (physical W key, any layout)
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault();
      devInstantWin();
    }
  });*/

  /* ───────── toggles / restart ───────── */
  soundToggle.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    winSound.muted =
      drumroll.muted =
      loseSound.muted =
      lose2.muted =
      koolAid.muted =
      airhorn.muted =
      cmon.muted =
      nelly.muted =
      silencer.muted =
      chewy.muted =
        !soundEnabled;
    soundToggle.textContent = soundEnabled ? "🔊 Sound" : "🔇 Sound";
  });
  restartBtn.addEventListener("click", startGame);
  document
    .querySelectorAll('input[name="diceMode"]')
    .forEach((r) => r.addEventListener("change", updateImmediateOdds));

  /* ───────── game-flow helpers ───────── */
  function checkWinLose() {
    if (flipped.size === 12) stopGame(true);
  }

  function playRandomLoseSound() {
    if (!soundEnabled) return;
    const clips = [loseSound, lose2, chewy];
    const clip = clips[Math.floor(Math.random() * clips.length)];
    clip.currentTime = 0;
    clip.play().catch(() => {});
  }

  /* ───────── simple confetti helper ───────── */
  const confettiColors = ["#FFFFFF", "#3AB4EF"]; // white & brand-blue
  let confettiCanvas,
    confettiCtx,
    confettiRunning = false;

  function initConfettiCanvas() {
    if (confettiCanvas) return; // already created
    confettiCanvas = document.createElement("canvas");
    confettiCanvas.id = "confetti";
    Object.assign(confettiCanvas.style, {
      position: "fixed",
      inset: 0,
      pointerEvents: "none",
      zIndex: 999,
    });
    document.body.appendChild(confettiCanvas);
    confettiCtx = confettiCanvas.getContext("2d");
    resizeConfetti();
    window.addEventListener("resize", resizeConfetti);
  }

  function resizeConfetti() {
    if (!confettiCanvas) return;
    confettiCanvas.width = window.innerWidth * devicePixelRatio;
    confettiCanvas.height = window.innerHeight * devicePixelRatio;
    confettiCtx.scale(devicePixelRatio, devicePixelRatio);
  }

  function launchConfetti() {
    initConfettiCanvas();
    const particles = [];

    // create 180 paper rectangles
    for (let i = 0; i < 180; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: -Math.random() * 40,
        w: 6 + Math.random() * 4,
        h: 8 + Math.random() * 6,
        vz: Math.random() * 2 + 1, // fall speed
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 10, // spin
        col: confettiColors[Math.random() < 0.3 ? 0 : 1], // mostly brand blue
        ttl: 240 + Math.random() * 60, // frames to live
      });
    }

    if (confettiRunning) return; // already animating
    confettiRunning = true;

    (function frame() {
      confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      particles.forEach((p) => {
        p.y += p.vz;
        p.rot += p.vr;
        p.ttl--;

        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate((p.rot * Math.PI) / 180);
        confettiCtx.fillStyle = p.col;
        confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        confettiCtx.restore();
      });

      // keep only live particles
      let alive = particles.filter(
        (p) => p.ttl > 0 && p.y < window.innerHeight + 20,
      );
      particles.length = 0;
      particles.push(...alive);

      if (particles.length) requestAnimationFrame(frame);
      else {
        confettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        confettiRunning = false;
      }
    })();
  }

  /* ───────── share-card helpers ───────── */
  let rollCount = 0; // counts rolls this round

  function makeShareCard(rolls) {
    const W = 400,
      H = 200;
    const cvs = document.createElement("canvas");
    cvs.width = W;
    cvs.height = H;
    const g = cvs.getContext("2d");

    // background
    g.fillStyle = "#0b1624";
    g.fillRect(0, 0, W, H);

    // title
    g.fillStyle = "#3AB4EF";
    g.font = "bold 28px Franklin Gothic Book, sans-serif";
    g.textAlign = "center";
    g.fillText("I Shut the Box!", W / 2, 50);

    // trophy emoji
    g.font = "48px serif";
    g.fillText("🏆", W / 2, 110);

    // rolls line
    g.font = "bold 24px Franklin Gothic Book, sans-serif";
    g.fillStyle = "#ffffff";
    g.fillText(`in ${rolls} roll${rolls === 1 ? "" : "s"}!`, W / 2, 160);

    return cvs;
  }

  async function shareCard(rolls) {
    const cvs = makeShareCard(rolls);

    /* ── A. copy to clipboard (same as before) ── */
    cvs.toBlob(async (blob) => {
      const item = new ClipboardItem({ "image/png": blob });
      try {
        await navigator.clipboard.write([item]);
      } catch {
        /* ignore if permission denied */
      }
    }, "image/png");

    /* ── B. also show it on-screen ── */
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,.65)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 1001,
      cursor: "pointer",
    });

    const img = new Image();
    img.src = cvs.toDataURL("image/png");
    img.style.maxWidth = "90%";
    img.style.boxShadow = "0 0 18px #000, 0 0 8px #3AB4EF";
    overlay.appendChild(img);

    /* click anywhere to dismiss */
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }

  /* END SHARE CARD CODE */

  async function stopGame(won) {
    awaitingPick = false;
    gameOver = true;
    rollBtn.disabled = true;

    // 👇 Clearer end-of-game banner
    if (won) {
      diceResEl.textContent = "🎉 YOU SHUT THE BOX!!!";
    } else {
      diceResEl.textContent = diceResEl.textContent + " ☠️  Restarting…";
    }

    if (won) {
      winSound.play();
      launchConfetti();
      shareCard(rollCount);
    } else {
      playRandomLoseSound();
    }

    // Close all PerpPlay positions if in that mode
    if (playMode === 'perpplay' && walletConnected && window.HyperliquidManager) {
      const positions = await window.HyperliquidManager.getGamePositionsWithPnL();
      if (positions.length > 0) {
        // Set context for modal button handlers
        endGameModalContext = { recordStats: true, won: won };

        // Show end game modal with position selection
        const modalTitle = won ? 'You Won!' : 'Game Over!';
        await showEndGameModal(modalTitle, won);

        return; // Don't auto-restart, handled by modal buttons
      } else {
        // PerpPlay mode but no positions - still record stats (with 0 volume/pnl)
        await recordPerpPlayResult(won, currentGameVolume, 0);
        currentGameVolume = 0;
        currentGamePnl = 0;
      }
    } else {
      // Free Play mode - record stats
      await recordFreePlayResult(won);
    }

    // Standard auto-restart for losses (when not in PerpPlay or no positions)
    if (!won) {
      setTimeout(startGame, 1900);
    }
  }

  function startGame() {
    rollCount = 0;
    drumrollPlayed = false;
    flipped.clear();
    newlyFlipped.clear();
    awaitingPick = false;
    gameOver = false;
    rollBtn.disabled = false;
    diceTotal = 0;
    cursor = 1;
    remainingEl.textContent = TOTAL_START;
    diceResEl.textContent = "";
    drawBoard();
    nelly.currentTime = 0; // allow Nelly to play again

    // Reset game tracking
    currentGameVolume = 0;
    currentGamePnl = 0;

    // Reset position table for PerpPlay mode (unless keeping positions)
    if (playMode === 'perpplay' && window.HyperliquidManager) {
      if (!skipPositionClear) {
        window.HyperliquidManager.clearGamePositions();
      }
      skipPositionClear = false; // Reset flag for next game
      updatePositionTable();
    }
  }

  /* ───────── mobile ↔ desktop: move elements for optimal layout ───────── */
  function relocateMobileElements() {
    const sidebar = document.querySelector(".right-container");
    const boardWrap = document.getElementById("boardWrap");
    const collateralSection = document.getElementById("collateralSection");
    const oddsDisplay = document.getElementById("immediateOddsDisplay");
    const controls = document.getElementById("controls");
    const controlsBox = document.getElementById("controlsBox");

    if (window.innerWidth <= 800) {
      /* ---- mobile layout reordering ---- */

      // Move collateral section right after boardWrap (which contains position table)
      if (collateralSection && boardWrap && boardWrap.nextSibling !== collateralSection) {
        boardWrap.parentNode.insertBefore(collateralSection, boardWrap.nextSibling);
      }

      // Move odds display after the dice controls
      if (oddsDisplay && controls && controls.nextSibling !== oddsDisplay) {
        controls.parentNode.insertBefore(oddsDisplay, controls.nextSibling);
      }
    } else {
      /* ---- desktop: snap everything back into the sidebar ---- */
      if (sidebar) {
        // Restore order: odds, collateral, controlsBox
        if (oddsDisplay && !sidebar.contains(oddsDisplay)) {
          sidebar.insertBefore(oddsDisplay, sidebar.firstChild);
        }
        if (collateralSection && !sidebar.contains(collateralSection)) {
          sidebar.insertBefore(collateralSection, oddsDisplay ? oddsDisplay.nextSibling : sidebar.firstChild);
        }
        if (controlsBox && !sidebar.contains(controlsBox)) {
          sidebar.appendChild(controlsBox);
        }
      }
    }
  }

  window.addEventListener("resize", relocateMobileElements);
  relocateMobileElements(); // run once on load

  /* ───────── Auto-reconnect wallet on page load ───────── */
  async function tryAutoReconnect() {
    if (!window.HyperliquidManager) {
      console.log('HyperliquidManager not available for auto-reconnect');
      return;
    }

    console.log('Attempting auto-reconnect...');
    const result = await window.HyperliquidManager.tryReconnect();

    if (result.success) {
      console.log('Auto-reconnect successful!');
      walletConnected = true;
      connectedWalletAddress = result.address;
      playMode = 'perpplay';
      updateModeButtons();

      // Show a brief notification that we reconnected
      if (result.restored) {
        console.log('Wallet session restored from previous visit');
      }
    } else {
      console.log('Auto-reconnect not possible:', result.reason);
      // Don't show any error to user - just stay in free play mode
    }
  }

  // Try auto-reconnect on page load
  tryAutoReconnect();

  // Listen for wallet account changes
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
      if (walletConnected) {
        console.log('Wallet account changed, disconnecting...');
        disconnectWallet();
      }
    });

    window.ethereum.on('chainChanged', () => {
      // Reload recommended by MetaMask docs on chain change
      if (walletConnected) {
        console.log('Chain changed while connected');
      }
    });
  }

  /* ───────── initialise ───────── */
  startGame();
});
