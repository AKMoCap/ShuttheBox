// hyperliquid.js - Wallet connection and Hyperliquid trading integration
// Uses the nomeida/hyperliquid SDK for reliable signing

const HyperliquidManager = (() => {
  // Configuration
  const CONFIG = {
    BUILDER_ADDRESS: '0x7b4497c1b70de6546b551bdf8f951da53b71b97d',
    BUILDER_FEE_BPS: 50, // 5 basis points in tenths (50 = 5 bps)
    MAX_FEE_RATE: '0.1%',
    POSITION_CLOSE_DELAY_MS: 15000,
    TOP_TOKENS_COUNT: 25,
    USE_TESTNET: false
  };

  // Helper to get correct chain ID based on network
  const getUserSignedChainId = () => CONFIG.USE_TESTNET ? CONFIG.TESTNET_USER_SIGNED_CHAIN_ID : CONFIG.MAINNET_USER_SIGNED_CHAIN_ID;
  const getUserSignedChainIdHex = () => CONFIG.USE_TESTNET ? CONFIG.TESTNET_USER_SIGNED_CHAIN_ID_HEX : CONFIG.MAINNET_USER_SIGNED_CHAIN_ID_HEX;

  // State
  let sdk = null;
  let walletAddress = null;
  let isConnected = false;
  let agentPrivateKey = null;
  let agentSdk = null;

  // Check if wallet is available
  const isWalletAvailable = () => {
    return typeof window !== 'undefined' && (window.ethereum || window.rabby);
  };

  // Connect wallet
  const connectWallet = async (walletType = 'metamask') => {
    try {
      // Check for wallet
      const ethereum = walletType === 'rabby' && window.rabby ? window.rabby : window.ethereum;

      if (!ethereum) {
        throw new Error('No Rabby or MetaMask wallet detected!');
      }

      console.log('Requesting wallet connection...');

      // Request accounts
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts found. Please unlock your wallet.');
      }

      walletAddress = accounts[0].toLowerCase();
      console.log('Wallet connected:', walletAddress);

      // Step 1: Create agent wallet and get approval signature
      console.log('=== STEP 1: Creating Agent Wallet ===');
      const agentResult = await createAndApproveAgent(ethereum);
      if (!agentResult.success) {
        throw new Error('Agent wallet approval failed: ' + agentResult.error);
      }
      console.log('Agent wallet created:', agentResult.agentAddress);

      // Step 2: Approve builder fees
      console.log('=== STEP 2: Approving Builder Fees ===');
      const builderResult = await approveBuilderFee(ethereum);
      if (!builderResult.success) {
        console.warn('Builder fee approval failed (non-critical):', builderResult.error);
      } else {
        console.log('Builder fee approved');
      }

      // Initialize SDK with agent wallet for trading
      agentSdk = new HyperliquidSDK.Hyperliquid({
        privateKey: agentPrivateKey,
        walletAddress: walletAddress,
        testnet: CONFIG.USE_TESTNET
      });

      await agentSdk.connect();
      isConnected = true;

      return {
        success: true,
        address: walletAddress
      };
    } catch (error) {
      console.error('Wallet connection error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  };

  // Create agent wallet and get user approval
  const createAndApproveAgent = async (ethereum) => {
    try {
      // Generate new agent wallet
      const agentWallet = ethers.Wallet.createRandom();
      agentPrivateKey = agentWallet.privateKey;
      const agentAddress = agentWallet.address.toLowerCase();

      const nonce = Date.now();

      // EIP-712 typed data for approveAgent
      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' }
          ]
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 421614, // Arbitrum Sepolia for user-signed actions
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          agentAddress: agentAddress,
          agentName: 'PerpPlay',
          nonce: nonce
        }
      };

      console.log('Requesting agent approval signature...');

      // Request signature from user's wallet
      const signature = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [walletAddress, JSON.stringify(typedData)]
      });

      const sig = ethers.utils.splitSignature(signature);

      // Send to Hyperliquid API
      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveAgent',
            hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
            signatureChainId: '0x66eee',
            agentAddress: agentAddress,
            agentName: 'PerpPlay',
            nonce: nonce
          },
          nonce: nonce,
          signature: { r: sig.r, s: sig.s, v: sig.v },
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Agent approval response:', result);

      if (result.status === 'ok') {
        return { success: true, agentAddress: agentAddress };
      } else {
        return { success: false, error: result.response || 'Unknown error' };
      }
    } catch (error) {
      console.error('Agent approval error:', error);
      return { success: false, error: error.message };
    }
  };

  // Approve builder fee
  const approveBuilderFee = async (ethereum) => {
    try {
      const nonce = Date.now();

      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          'HyperliquidTransaction:ApproveBuilderFee': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'maxFeeRate', type: 'string' },
            { name: 'builder', type: 'address' },
            { name: 'nonce', type: 'uint64' }
          ]
        },
        primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 421614,
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          maxFeeRate: CONFIG.MAX_FEE_RATE,
          builder: CONFIG.BUILDER_ADDRESS,
          nonce: nonce
        }
      };

      console.log('Requesting builder fee approval signature...');

      const signature = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [walletAddress, JSON.stringify(typedData)]
      });

      const sig = ethers.utils.splitSignature(signature);

      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveBuilderFee',
            hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
            signatureChainId: '0x66eee',
            maxFeeRate: CONFIG.MAX_FEE_RATE,
            builder: CONFIG.BUILDER_ADDRESS,
            nonce: nonce
          },
          nonce: nonce,
          signature: { r: sig.r, s: sig.s, v: sig.v },
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Builder fee approval response:', result);

      return { success: result.status === 'ok', error: result.response };
    } catch (error) {
      console.error('Builder fee approval error:', error);
      return { success: false, error: error.message };
    }
  };

  // Disconnect wallet
  const disconnectWallet = () => {
    sdk = null;
    agentSdk = null;
    walletAddress = null;
    isConnected = false;
    agentPrivateKey = null;
    console.log('Wallet disconnected');
  };

  // Get top tokens by open interest
  const getTopTokensByOI = async () => {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      });

      const data = await response.json();
      const meta = data[0];
      const contexts = data[1];

      const assets = meta.universe.map((asset, index) => ({
        name: asset.name,
        index: index,
        szDecimals: asset.szDecimals,
        openInterest: parseFloat(contexts[index]?.openInterest || '0'),
        markPrice: parseFloat(contexts[index]?.markPx || '0'),
        maxLeverage: asset.maxLeverage || 50
      }));

      return assets
        .filter(a => a.openInterest > 0 && a.markPrice > 0)
        .sort((a, b) => b.openInterest - a.openInterest)
        .slice(0, CONFIG.TOP_TOKENS_COUNT);
    } catch (error) {
      console.error('Error fetching tokens:', error);
      return [];
    }
  };

  // Get random top token
  const getRandomTopToken = async () => {
    const tokens = await getTopTokensByOI();
    if (tokens.length === 0) return null;
    return tokens[Math.floor(Math.random() * tokens.length)];
  };

  // Open a long position using the SDK
  const openLongPosition = async (token, collateralUsd = 10) => {
    if (!agentSdk || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      const leverage = Math.min(token.maxLeverage, 20);
      const sizeUsd = collateralUsd * leverage;
      const sizeBase = sizeUsd / token.markPrice;
      const roundedSize = Math.round(sizeBase * Math.pow(10, token.szDecimals)) / Math.pow(10, token.szDecimals);

      console.log(`Opening LONG: ${token.name}, size: ${roundedSize}, leverage: ${leverage}x`);

      // Use SDK to place order
      const result = await agentSdk.exchange.placeOrder({
        coin: token.name,
        is_buy: true,
        sz: roundedSize,
        limit_px: token.markPrice * 1.01, // 1% slippage
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: false,
        builder: {
          b: CONFIG.BUILDER_ADDRESS,
          f: CONFIG.BUILDER_FEE_BPS
        }
      });

      console.log('Order result:', result);

      return {
        success: true,
        token: token.name,
        side: 'LONG',
        size: roundedSize,
        leverage: leverage,
        collateral: collateralUsd,
        entryPrice: token.markPrice,
        result: result
      };
    } catch (error) {
      console.error('Error opening position:', error);
      return { success: false, error: error.message };
    }
  };

  // Close a position
  const closePosition = async (token, size) => {
    if (!agentSdk || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      // Get current price
      const tokens = await getTopTokensByOI();
      const currentToken = tokens.find(t => t.name === token.name);
      const currentPrice = currentToken?.markPrice || token.markPrice;

      const result = await agentSdk.exchange.placeOrder({
        coin: token.name,
        is_buy: false,
        sz: Math.abs(size),
        limit_px: currentPrice * 0.99, // 1% slippage
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: true
      });

      console.log('Close result:', result);

      return {
        success: true,
        exitPrice: currentPrice,
        result: result
      };
    } catch (error) {
      console.error('Error closing position:', error);
      return { success: false, error: error.message };
    }
  };

  // Execute a PerpPlay trade (open, wait, close)
  const executePerpPlayTrade = async (collateralUsd = 10) => {
    const token = await getRandomTopToken();
    if (!token) {
      return { success: false, error: 'No tokens available' };
    }

    const openResult = await openLongPosition(token, collateralUsd);
    if (!openResult.success) {
      return openResult;
    }

    return {
      success: true,
      token: token,
      openResult: openResult,
      closeAfterMs: CONFIG.POSITION_CLOSE_DELAY_MS
    };
  };

  // Public API
  return {
    isWalletAvailable,
    connectWallet,
    disconnectWallet,
    getTopTokensByOI,
    getRandomTopToken,
    openLongPosition,
    closePosition,
    executePerpPlayTrade,
    get isConnected() { return isConnected; },
    get walletAddress() { return walletAddress; },
    CONFIG
  };
})();
