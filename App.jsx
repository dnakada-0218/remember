import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
    getFirestore, collection, query, orderBy, onSnapshot, 
    addDoc, setDoc, deleteDoc, doc, Timestamp 
} from 'firebase/firestore';

// --- 設定値 ---

// 1. Slack Webhook URL
const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/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";

// 2. アプリケーション共有パスキー
const APP_PASSCODE = "1008"; 

// 3. Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyBORcAu-VSZi2NnQWXtLutRU0O_ZLCAeJA",
  authDomain: "remember-storage-management.firebaseapp.com",
  projectId: "remember-storage-management",
  storageBucket: "remember-storage-management.firebasestorage.app",
  messagingSenderId: "520063780688",
  appId: "1:520063780688:web:bf469c52d3932fcc83ce55",
  measurementId: "G-WMF4ZXDFT8"
};

const appId = 'nightbar-app';
const PRODUCT_CATEGORIES = [
    'ビール', 'ウイスキー', 'カクテル', '焼酎', '日本酒', 'ジン', 
    'ウォッカ', 'ソフトドリンク', '炭酸飲料', '食品', 'その他'
];
const TAX_RATE = 0.10;

let app = null;
let db = null;
let auth = null;

// --- ヘルパー関数 ---

const formatCurrency = (amount) => {
    if (amount === null || amount === undefined || isNaN(Number(amount))) return '¥0';
    return `¥${Math.round(amount).toLocaleString()}`;
};

const formatQuantity = (quantity, unit) => {
    if (quantity === null || quantity === undefined || isNaN(Number(quantity))) return '0';
    const num = Number(quantity);
    const formattedQuantity = Number.isInteger(num) ? num.toFixed(0) : num.toFixed(2);
    return `${formattedQuantity}${unit}`;
};

const calculateCostRate = (costPrice, salePrice) => {
    if (!costPrice || !salePrice) return '-';
    const untaxedSalePrice = salePrice / (1 + TAX_RATE);
    if (untaxedSalePrice <= 0) return '∞';
    const rate = (costPrice / untaxedSalePrice) * 100;
    return `${rate.toFixed(1)}%`;
};

const calculateAverageUnitPrice = (productId, purchases) => {
    const productLots = purchases.filter(p => p.productId === productId && p.remainingQuantity > 0);
    if (productLots.length === 0) return 0;
    
    let totalValue = 0;
    let totalQuantity = 0;
    productLots.forEach(lot => {
        totalValue += lot.unitPrice * lot.remainingQuantity;
        totalQuantity += lot.remainingQuantity;
    });
    return totalQuantity > 0 ? totalValue / totalQuantity : 0;
};

const calculateFifoInventoryValue = (purchases, endingInventoryAmount) => {
    let remainingAmountToEvaluate = endingInventoryAmount;
    let totalValue = 0;
    const evaluationDetails = [];

    if (endingInventoryAmount <= 0) {
        return { value: 0, evaluationDetails: [] };
    }

    const sortedPurchases = [...purchases].sort((a, b) => 
        new Date(a.purchaseDate) - new Date(b.purchaseDate)
    );

    for (const lot of sortedPurchases) {
        if (remainingAmountToEvaluate <= 0) break;
        const quantityFromLot = Math.min(lot.totalQuantity, remainingAmountToEvaluate);

        if (quantityFromLot > 0) {
            const value = quantityFromLot * lot.unitPrice;
            totalValue += value;
            remainingAmountToEvaluate -= quantityFromLot;

            evaluationDetails.push({
                date: lot.purchaseDate,
                price: lot.unitPrice,
                quantity: quantityFromLot,
                value: value,
            });
        }
    }
    return { value: totalValue, evaluationDetails };
};

// --- Slack通知関数 ---
const sendSlackNotification = async (orderItems) => {
    if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.includes("YOUR_SLACK")) {
        console.warn("Slack URL未設定");
        return;
    }
    const urgentItems = orderItems.filter(item => item.isUrgent);
    const normalItems = orderItems.filter(item => !item.isUrgent);

    let messageText = "<!channel> 仕入れの追加をお願いします\n\n";

    if (urgentItems.length > 0) {
        messageText += "[URGENT]\n";
        urgentItems.forEach(item => {
            messageText += `${item.productName}　${item.quantity}${item.unit}\n`;
        });
        messageText += "\n";
    }

    if (normalItems.length > 0) {
        messageText += "[その他]\n";
        normalItems.forEach(item => {
            messageText += `${item.productName}　${item.quantity}${item.unit}\n`;
        });
    }

    try {
        await fetch(SLACK_WEBHOOK_URL, { method: 'POST', body: JSON.stringify({ text: messageText }) });
    } catch (error) {
        console.error("Slack notification failed:", error);
        // CORSエラー回避のためのno-corsモード試行
        try {
            await fetch(SLACK_WEBHOOK_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ text: messageText }) });
        } catch (e) {
            throw new Error("Slackへの送信に失敗しました");
        }
    }
};

// --- コンポーネント群 ---

const LoginScreen = ({ onUnlock }) => {
    const [inputCode, setInputCode] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (inputCode === APP_PASSCODE) {
            onUnlock();
        } else {
            setError('パスコードが間違っています');
            setInputCode('');
        }
    };

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-gray-900 px-4">
            <div className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-sm">
                <h1 className="text-2xl font-bold text-center text-gray-800 mb-6">NightBar System</h1>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <input
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            placeholder="Passcode"
                            className="w-full text-center text-2xl tracking-widest p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                            value={inputCode}
                            onChange={(e) => {
                                setInputCode(e.target.value);
                                setError('');
                            }}
                            autoFocus
                        />
                    </div>
                    {error && <p className="text-red-500 text-sm text-center font-medium">{error}</p>}
                    <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition duration-200 shadow-md">
                        LOGIN
                    </button>
                </form>
            </div>
        </div>
    );
};

const SideBar = ({ view, setView }) => {
    const items = [
        { id: "dashboard", label: "在庫一覧" },
        { id: "orderRequest", label: "発注依頼" },
        { id: "itemMaster", label: "仕入れ品目マスタ" },
        { id: "purchase", label: "仕入れ登録" },
        { id: "recipeMaster", label: "原価管理" },
        { id: "salesList", label: "価格管理" },
        { id: "monthlyInventory", label: "月末棚卸" },
    ];
    return (
        <nav className="w-64 bg-gray-900 shadow-2xl flex flex-col p-4 flex-shrink-0 hidden md:flex h-screen sticky top-0">
            <h1 className="text-2xl font-bold text-white mb-6 pt-2 pb-4 border-b border-gray-700">Bar Manager</h1>
            <div className="flex flex-col space-y-2">
                {items.map(item => (
                    <button 
                        key={item.id} 
                        onClick={() => setView(item.id)} 
                        className={`px-4 py-3 text-left rounded-lg transition font-medium ${view === item.id ? 'bg-blue-600 text-white shadow-md' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </nav>
    );
};

const MobileNav = ({ view, setView }) => (
    <div className="md:hidden bg-gray-900 text-white p-4 overflow-x-auto whitespace-nowrap sticky top-0 z-50 shadow-md w-full">
            <div className="flex space-x-4">
            <button onClick={() => setView('dashboard')} className={view === 'dashboard' ? 'font-bold text-blue-400' : ''}>在庫</button>
            <button onClick={() => setView('orderRequest')} className={view === 'orderRequest' ? 'font-bold text-blue-400' : ''}>発注</button>
            <button onClick={() => setView('itemMaster')} className={view === 'itemMaster' ? 'font-bold text-blue-400' : ''}>マスタ</button>
            <button onClick={() => setView('purchase')} className={view === 'purchase' ? 'font-bold text-blue-400' : ''}>仕入</button>
            <button onClick={() => setView('salesList')} className={view === 'salesList' ? 'font-bold text-blue-400' : ''}>価格</button>
            </div>
    </div>
);

const OrderRequest = ({ products, setMessage }) => {
    const [cart, setCart] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [confirming, setConfirming] = useState(false);

    const filteredProducts = useMemo(() => {
        if (!searchTerm) return products;
        const lower = searchTerm.toLowerCase();
        return products.filter(p => 
            p.productName.toLowerCase().includes(lower) || 
            p.category.includes(lower)
        );
    }, [products, searchTerm]);

    const addToCart = (product) => {
        if (cart.find(item => item.id === product.id)) {
            setMessage(`${product.productName}は既に追加されています`);
            return;
        }
        setCart([...cart, { ...product, quantity: 1, isUrgent: false }]);
        setConfirming(false);
    };

    const updateCartItem = (id, field, value) => {
        setCart(cart.map(item => item.id === id ? { ...item, [field]: value } : item));
    };

    const removeFromCart = (id) => {
        setCart(cart.filter(item => item.id !== id));
        setConfirming(false);
    };

    const handleSubmit = async () => {
        if (cart.length === 0) return;
        if (!confirming) {
            setConfirming(true);
            return;
        }
        setIsSubmitting(true);
        try {
            await sendSlackNotification(cart);
            setMessage('発注依頼をSlackへ送信しました！');
            setCart([]);
            setConfirming(false);
        } catch (e) {
            console.error(e);
            setMessage('エラー: Slackへの自動送信に失敗しました。手動で連絡してください。');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto">
            <h2 className="text-2xl font-semibold mb-6 border-b pb-2">発注依頼 (Slack通知)</h2>
            <div className="mb-8 p-4 bg-gray-50 rounded-lg border">
                <h3 className="text-lg font-medium mb-3">商品を追加</h3>
                <div className="flex gap-2 mb-4">
                    <input type="text" placeholder="商品名またはカテゴリーで検索..." className="flex-1 p-2 border border-gray-300 rounded" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                </div>
                <div className="max-h-60 overflow-y-auto border rounded bg-white">
                    {filteredProducts.map(product => (
                        <div key={product.id} className="flex justify-between items-center p-2 border-b hover:bg-gray-50 last:border-0">
                            <span className="text-sm md:text-base font-medium">[{product.category}] {product.productName}</span>
                            <button onClick={() => addToCart(product)} className="px-3 py-1 bg-blue-100 text-blue-700 text-sm rounded hover:bg-blue-200 whitespace-nowrap">追加</button>
                        </div>
                    ))}
                    {filteredProducts.length === 0 && <div className="p-4 text-center text-gray-500">該当する商品がありません</div>}
                </div>
            </div>
            <h3 className="text-lg font-medium mb-3">発注リスト {cart.length > 0 && <span className="text-sm font-normal text-gray-500">({cart.length}点)</span>}</h3>
            <div className="overflow-x-auto mb-6">
                <table className="min-w-full bg-white border border-gray-200 rounded-lg">
                    <thead className="bg-gray-100"><tr><Th>商品名</Th><Th className="text-center">数量</Th><Th className="text-center">緊急性</Th><Th className="text-center">削除</Th></tr></thead>
                    <tbody>
                        {cart.map((item) => (
                            <tr key={item.id} className="border-b">
                                <Td><div className="font-medium text-gray-800">{item.productName}</div><div className="text-xs text-gray-500">{item.capacity}{item.unit}</div></Td>
                                <Td className="text-center"><div className="flex items-center justify-center gap-1"><input type="number" min="0.1" step="0.1" value={item.quantity} onChange={(e) => updateCartItem(item.id, 'quantity', parseFloat(e.target.value))} className="w-20 p-1 border rounded text-right" /><span className="text-sm text-gray-600">{item.unit}</span></div></Td>
                                <Td className="text-center"><label className="inline-flex items-center cursor-pointer"><input type="checkbox" checked={item.isUrgent} onChange={(e) => updateCartItem(item.id, 'isUrgent', e.target.checked)} className="mr-2" /><span className={`text-sm ${item.isUrgent ? 'font-bold text-red-600' : 'text-gray-500'}`}>{item.isUrgent ? 'URGENT' : '通常'}</span></label></Td>
                                <Td className="text-center"><button onClick={() => removeFromCart(item.id)} className="text-red-500 hover:text-red-700 p-2">✕</button></Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <button onClick={handleSubmit} disabled={cart.length === 0 || isSubmitting} className={`w-full py-4 rounded-lg font-bold text-lg shadow-md transition-all duration-200 ${cart.length === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : isSubmitting ? 'bg-green-400 text-white cursor-wait' : confirming ? 'bg-orange-500 hover:bg-orange-600 text-white' : 'bg-green-600 hover:bg-green-700 text-white'}`}>
                {isSubmitting ? '送信中...' : confirming ? '本当に送信しますか？（もう一度クリック）' : 'Slackへ発注依頼を送信'}
            </button>
        </div>
    );
};

const ProductMaster = ({ products, onSave, onDelete }) => {
    const [form, setForm] = useState({ name: '', category: PRODUCT_CATEGORIES[0], capacity: '', unit: '本', id: null });
    const [msg, setMsg] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!form.name || !form.capacity) return setMsg('必須項目が不足しています');
        onSave({ productName: form.name, category: form.category, capacity: parseFloat(form.capacity), unit: form.unit }, form.id);
        setForm({ name: '', category: PRODUCT_CATEGORIES[0], capacity: '', unit: '本', id: null });
        setMsg('');
    };
    const handleEdit = (p) => setForm({ name: p.productName, category: p.category, capacity: p.capacity, unit: p.unit, id: p.id });

    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto">
            <h2 className="text-2xl font-semibold mb-6 border-b pb-2">仕入れ品目マスタ</h2>
            {msg && <div className="p-3 mb-4 bg-red-100 text-red-700 rounded">{msg}</div>}
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <InputField id="name" label="品目名" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="例: ボンベイ・サファイア" />
                <SelectField id="category" label="カテゴリー" value={form.category} onChange={v => setForm({ ...form, category: v })} options={PRODUCT_CATEGORIES} />
                <InputField id="capacity" label="容量" type="number" value={form.capacity} onChange={v => setForm({ ...form, capacity: v })} placeholder="700" />
                <SelectField id="unit" label="単位" value={form.unit} onChange={v => setForm({ ...form, unit: v })} options={['本', '個', '袋', 'g', 'ml']} />
                <div className="md:col-span-2 flex gap-2">
                    <button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-lg">{form.id ? '更新' : '登録'}</button>
                    {form.id && <button type="button" onClick={() => setForm({ name: '', category: PRODUCT_CATEGORIES[0], capacity: '', unit: '本', id: null })} className="bg-gray-400 text-white px-6 rounded-lg">キャンセル</button>}
                </div>
            </form>
            <div className="overflow-x-auto">
                <table className="min-w-full border rounded-lg">
                    <thead className="bg-gray-100"><tr><Th>品目名</Th><Th>カテゴリー</Th><Th>容量</Th><Th>操作</Th></tr></thead>
                    <tbody>
                        {products.map(p => (
                            <tr key={p.id} className="border-b hover:bg-gray-50">
                                <Td>{p.productName}</Td><Td>{p.category}</Td><Td>{p.capacity}{p.unit}</Td>
                                <Td><button onClick={() => handleEdit(p)} className="text-blue-600 mr-2">編集</button><button onClick={() => onDelete(p.id)} className="text-red-600">削除</button></Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const RecipeMaster = ({ products, productMap, recipes, onSave, onDelete }) => {
    const initialIng = { productId: '', quantity: '', calculationMode: 'capacity' };
    const [name, setName] = useState('');
    const [cat, setCat] = useState('カクテル');
    const [ings, setIngs] = useState([initialIng]);
    const [id, setId] = useState(null);
    const [msg, setMsg] = useState('');

    const handleSave = (e) => {
        e.preventDefault();
        const validIngs = ings.filter(i => i.productId && i.quantity > 0).map(i => ({ productId: i.productId, quantity: parseFloat(i.quantity), calculationMode: i.calculationMode }));
        if (!name || validIngs.length === 0) return setMsg('名前と有効な材料が必要です');
        onSave({ recipeName: name, category: cat, ingredients: validIngs }, id);
        setName(''); setIngs([initialIng]); setId(null); setMsg('');
    };

    const handleEdit = (r) => {
        setId(r.id); setName(r.recipeName); setCat(r.category || 'カクテル');
        const list = r.ingredients.map(i => ({ ...i, quantity: i.quantity.toString() }));
        while (list.length < 3) list.push(initialIng);
        setIngs(list.slice(0, 3));
    };

    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full max-w-4xl mx-auto">
            <h2 className="text-2xl font-semibold mb-6 border-b pb-2">原価管理レシピ</h2>
            {msg && <div className="p-3 mb-4 bg-red-100 text-red-700 rounded">{msg}</div>}
            <form onSubmit={handleSave} className="space-y-4 mb-8">
                <InputField id="rname" label="レシピ名" value={name} onChange={setName} />
                <SelectField id="rcat" label="カテゴリー" value={cat} onChange={setCat} options={PRODUCT_CATEGORIES} />
                <div className="space-y-2">
                    <p className="font-semibold text-gray-700">材料 (最大3つ)</p>
                    {ings.map((ing, idx) => (
                        <div key={idx} className="flex flex-col md:flex-row gap-2 border p-2 rounded bg-gray-50">
                            <select value={ing.productId} onChange={e => { const n = [...ings]; n[idx].productId = e.target.value; setIngs(n); }} className="p-2 border rounded flex-1">
                                <option value="">材料を選択</option>
                                {products.map(p => <option key={p.id} value={p.id}>{p.productName}</option>)}
                            </select>
                            <select value={ing.calculationMode} onChange={e => { const n = [...ings]; n[idx].calculationMode = e.target.value; setIngs(n); }} className="p-2 border rounded w-full md:w-32">
                                <option value="capacity">容量換算</option><option value="unit">個数換算</option>
                            </select>
                            <input type="number" step="0.1" value={ing.quantity} onChange={e => { const n = [...ings]; n[idx].quantity = e.target.value; setIngs(n); }} className="p-2 border rounded w-full md:w-24" placeholder="量" />
                        </div>
                    ))}
                    {ings.length < 3 && <button type="button" onClick={() => setIngs([...ings, initialIng])} className="text-blue-600 text-sm">+ 材料追加</button>}
                </div>
                <button className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold hover:bg-blue-700">{id ? '更新' : '登録'}</button>
            </form>
            <div className="overflow-x-auto">
                <table className="min-w-full border rounded-lg">
                    <thead className="bg-gray-100"><tr><Th>レシピ名</Th><Th>材料概要</Th><Th>操作</Th></tr></thead>
                    <tbody>
                        {recipes.map(r => (
                            <tr key={r.id} className="border-b"><Td>{r.recipeName}</Td>
                                <Td className="text-xs text-gray-600">{(r.ingredients || []).map(i => productMap[i.productId]?.productName || '不明').join(', ')}</Td>
                                <Td><button onClick={() => handleEdit(r)} className="text-blue-600 mr-2">編集</button><button onClick={() => onDelete(r.id)} className="text-red-600">削除</button></Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const PurchaseRegistration = ({ products, onRegister, setMessage }) => {
    const [pid, setPid] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!pid || !price || !qty) return setMessage('エラー: 全ての項目を入力してください');
        onRegister({ productId: pid, purchaseDate: date, unitPrice: price, totalQuantity: qty });
        setPrice(''); setQty('');
    };

    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg max-w-2xl mx-auto">
            <h2 className="text-2xl font-semibold mb-6 border-b pb-2">仕入れ登録</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex flex-col">
                    <label className="text-sm font-medium mb-1">品目</label>
                    <select value={pid} onChange={e => setPid(e.target.value)} className="p-3 border rounded-lg w-full">
                        <option value="">選択してください</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.productName}</option>)}
                    </select>
                </div>
                <InputField id="date" label="日付" type="date" value={date} onChange={setDate} />
                <InputField id="price" label="単価 (円)" type="number" value={price} onChange={setPrice} />
                <InputField id="qty" label="数量" type="number" value={qty} onChange={setQty} />
                <button className="w-full bg-green-600 text-white font-bold py-3 rounded-lg hover:bg-green-700">登録</button>
            </form>
        </div>
    );
};

const InventoryCard = ({ stock }) => (
    <div className="flex justify-between items-center p-4 bg-gray-50 rounded-lg border">
        <div>
            <div className="font-bold text-lg">{stock.product.productName}</div>
            <div className="text-sm text-gray-500">最終仕入: {stock.lots[stock.lots.length-1]?.purchaseDate}</div>
        </div>
        <div className="text-right">
            <div className="text-2xl font-bold text-blue-600">{stock.formattedStock}</div>
            <div className="text-xs text-gray-400">在庫ロット数: {stock.lots.length}</div>
        </div>
    </div>
);

const Dashboard = ({ currentStock, productMap, message }) => {
    const stockList = Object.values(currentStock).filter(s => s.totalRemaining > 0);
    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full">
            <h2 className="text-3xl font-bold mb-6 text-gray-800">在庫一覧</h2>
            {message && <div className="p-3 mb-4 bg-green-100 text-green-700 rounded whitespace-pre-wrap">{message}</div>}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                <div className="p-5 rounded-xl text-white bg-blue-500 shadow"><p>品目種類数</p><p className="text-3xl font-bold">{Object.keys(productMap).length}</p></div>
                <div className="p-5 rounded-xl text-white bg-green-500 shadow"><p>在庫あり</p><p className="text-3xl font-bold">{stockList.length}</p></div>
            </div>
            <div className="space-y-4">
                {stockList.length === 0 ? <p className="text-center text-gray-500">在庫がありません</p> : stockList.map(s => <InventoryCard key={s.product.id} stock={s} />)}
            </div>
        </div>
    );
};

const SalesPriceList = ({ finalProductList, onUpdateSalePrice }) => {
    const [editId, setEditId] = useState(null);
    const [price, setPrice] = useState('');
    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full overflow-hidden">
            <h2 className="text-2xl font-semibold mb-6 border-b pb-2">価格管理</h2>
            <div className="overflow-x-auto">
                <table className="min-w-full">
                    <thead className="bg-gray-100">
                        <tr><Th>商品名</Th><Th className="text-right whitespace-nowrap">原価</Th><Th className="text-right whitespace-nowrap">売価(税込)</Th><Th className="text-right whitespace-nowrap">原価率</Th><Th>操作</Th></tr>
                    </thead>
                    <tbody>
                        {finalProductList.sort((a,b)=>a.category.localeCompare(b.category)).map(p => (
                            <tr key={p.id} className="border-b">
                                <Td><span className="text-xs text-gray-500 mr-1">[{p.category}]</span>{p.productName}</Td>
                                <Td className="text-right text-red-600">{formatCurrency(p.costPrice)}</Td>
                                <Td className="text-right">
                                    {editId === p.id ? 
                                        <input type="number" value={price} onChange={e=>setPrice(e.target.value)} className="w-20 border rounded text-right" /> : 
                                        <span className="font-bold text-green-700">{formatCurrency(p.salePrice)}</span>}
                                </Td>
                                <Td className={`text-right ${parseFloat(p.costRate)>35?'text-red-600 font-bold':''}`}>{p.costRate}</Td>
                                <Td>
                                    {editId === p.id ? 
                                        <button onClick={() => { onUpdateSalePrice(p.id, parseFloat(price), p.isRecipe); setEditId(null); }} className="text-green-600 font-bold">保存</button> : 
                                        <button onClick={() => { setEditId(p.id); setPrice(p.salePrice); }} className="text-blue-600">編集</button>}
                                </Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const MonthlyInventory = ({ currentStock, allPurchases, setMessage }) => {
    const stockList = Object.values(currentStock).filter(s => s.totalRemaining > 0);
    const [inputs, setInputs] = useState({});
    const [result, setResult] = useState(null);

    const handleCalc = (e) => {
        e.preventDefault();
        let total = 0; const items = [];
        for (const stock of stockList) {
            const amount = parseFloat(inputs[stock.product.id] || '0');
            const { value, evaluationDetails } = calculateFifoInventoryValue(allPurchases.filter(p => p.productId === stock.product.id), amount);
            items.push({ product: stock.product, endingAmount: amount, inventoryValue: value, details: evaluationDetails });
            total += value;
        }
        setResult({ total, items, date: new Date().toISOString().split('T')[0] });
    };

    return (
        <div className="bg-white p-4 md:p-6 rounded-xl shadow-lg w-full">
            <h2 className="text-2xl font-semibold mb-6">月末棚卸</h2>
            <form onSubmit={handleCalc}>
                <div className="overflow-x-auto mb-4 border rounded">
                    <table className="min-w-full">
                        <thead className="bg-gray-50"><tr><Th>商品名</Th><Th>帳簿残量</Th><Th>実地棚卸数</Th></tr></thead>
                        <tbody>
                            {stockList.map(s => (
                                <tr key={s.product.id} className="border-b">
                                    <Td>{s.product.productName}</Td>
                                    <Td className="text-blue-600">{s.formattedStock}</Td>
                                    <Td><input type="number" step="0.1" className="border rounded p-1 w-24 text-right" placeholder="0" value={inputs[s.product.id]||''} onChange={e=>setInputs({...inputs, [s.product.id]:e.target.value})} /></Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <button className="bg-purple-600 text-white font-bold py-3 px-8 rounded hover:bg-purple-700 w-full md:w-auto">計算実行</button>
            </form>
            {result && (
                <div className="mt-8 bg-purple-50 p-6 rounded-xl border border-purple-200">
                    <h3 className="text-xl font-bold text-purple-800 mb-4">棚卸資産合計: {formatCurrency(result.total)}</h3>
                    <div className="space-y-2">
                        {result.items.map(i => <div key={i.product.id} className="flex justify-between border-b pb-1"><span>{i.product.productName} ({i.endingAmount}{i.product.unit})</span><span>{formatCurrency(i.inventoryValue)}</span></div>)}
                    </div>
                </div>
            )}
        </div>
    );
};

// --- App Component ---

const App = () => {
    const [isAppUnlocked, setIsAppUnlocked] = useState(false);
    const [view, setView] = useState('dashboard');
    const [products, setProducts] = useState([]);
    const [recipes, setRecipes] = useState([]);
    const [purchases, setPurchases] = useState([]);
    const [message, setMessage] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [user, setUser] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        const initFirebase = async () => {
            if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes("YOUR_API_KEY")) {
                setError("Firebase設定がありません。");
                setIsLoading(false);
                return;
            }
            try {
                if (!app) {
                    app = initializeApp(firebaseConfig);
                    db = getFirestore(app);
                    auth = getAuth(app);
                }
                const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
                    if (currentUser) {
                        setUser(currentUser);
                        setIsLoading(false);
                    } else {
                        signInAnonymously(auth).catch(err => {
                            console.error("Auth failed", err);
                            setError("認証に失敗しました");
                        });
                    }
                });
                return () => unsubscribe();
            } catch (err) {
                setError(`初期化エラー: ${err.message}`);
                setIsLoading(false);
            }
        };
        initFirebase();
    }, []);

    useEffect(() => {
        if (!user || !db) return;
        const sub = (path, sortKey, setFn, processFn) => {
            return onSnapshot(query(collection(db, 'artifacts', appId, 'users', user.uid, path), orderBy(sortKey)), 
                (snap) => {
                    const data = snap.docs.map(doc => {
                        const d = doc.data();
                        return { id: doc.id, ...d, purchaseDate: d.purchaseDate instanceof Timestamp ? d.purchaseDate.toDate().toISOString().split('T')[0] : d.purchaseDate };
                    });
                    setFn(processFn ? processFn(data) : data);
                },
                (err) => console.error(err)
            );
        };

        const u1 = sub('products', 'productName', setProducts);
        const u2 = sub('recipes', 'recipeName', setRecipes, (d) => d.map(r => ({...r, ingredients: (r.ingredients||[]).map(i=>({...i, quantity: parseFloat(i.quantity)}))})));
        const u3 = sub('purchases', 'purchaseDate', setPurchases);

        return () => { u1(); u2(); u3(); };
    }, [user]);

    useEffect(() => { if (message) setTimeout(() => setMessage(''), 5000); }, [message]);

    const productMap = useMemo(() => products.reduce((acc, p) => ({ ...acc, [p.id]: p }), {}), [products]);
    
    const averageUnitCostMap = useMemo(() => {
        const map = {};
        products.forEach(p => {
            const avg = calculateAverageUnitPrice(p.id, purchases);
            map[p.id] = avg;
            map[`${p.id}_PER_CAPACITY`] = p.capacity > 0 ? avg / p.capacity : avg;
        });
        return map;
    }, [products, purchases]);

    const finalProductList = useMemo(() => {
        const list = [];
        products.forEach(item => {
            const cost = averageUnitCostMap[item.id] || 0;
            list.push({ ...item, costPrice: cost, costRate: calculateCostRate(cost, item.salePrice), isRecipe: false });
        });
        recipes.forEach(recipe => {
            let totalCost = 0;
            (recipe.ingredients || []).forEach(ing => {
                const item = productMap[ing.productId];
                if (!item) return;
                const cost = ing.calculationMode === 'unit' ? (averageUnitCostMap[item.id] || 0) : (averageUnitCostMap[`${item.id}_PER_CAPACITY`] || 0);
                totalCost += cost * ing.quantity;
            });
            const rp = { id: recipe.id, productName: recipe.recipeName, category: recipe.category || 'カクテル', capacity: 1, unit: '杯', salePrice: recipe.salePrice || 0, costPrice: totalCost };
            rp.costRate = calculateCostRate(rp.costPrice, rp.salePrice);
            rp.isRecipe = true;
            list.push(rp);
        });
        return list;
    }, [products, recipes, averageUnitCostMap, productMap]);

    const currentStock = useMemo(() => {
        const stock = {};
        const lotsByProduct = purchases.reduce((acc, lot) => {
            if (!acc[lot.productId]) acc[lot.productId] = [];
            if (lot.remainingQuantity > 0) acc[lot.productId].push(lot);
            return acc;
        }, {});

        products.forEach(p => {
            const lots = lotsByProduct[p.id] || [];
            const totalRemaining = lots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
            stock[p.id] = { product: p, totalRemaining, lots: lots.sort((a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate)), formattedStock: formatQuantity(totalRemaining, p.unit) };
        });
        return stock;
    }, [products, purchases]);

    const handleUpdateSalePrice = async (id, newPrice, isRecipe) => {
        if (!user) return;
        await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, isRecipe ? 'recipes' : 'products', id), { salePrice: newPrice }, { merge: true });
        setMessage('販売価格を更新しました。');
    };
    
    const handleSaveProduct = async (data, id) => {
        if (!user) return;
        const colRef = collection(db, 'artifacts', appId, 'users', user.uid, 'products');
        if (id) await setDoc(doc(colRef, id), data); else await addDoc(colRef, data);
        setMessage(id ? '品目を更新しました。' : '品目を登録しました。');
    };
    
    const handleDeleteProduct = async (id) => {
        if (!user) await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'products', id));
        setMessage('品目を削除しました。');
    };
    
    const handleSaveRecipe = async (data, id) => {
        if (!user) return;
        const colRef = collection(db, 'artifacts', appId, 'users', user.uid, 'recipes');
        if (id) await setDoc(doc(colRef, id), data); else await addDoc(colRef, data);
        setMessage(id ? 'レシピを更新しました。' : 'レシピを登録しました。');
    };
    
    const handleDeleteRecipe = async (id) => {
        if (!user) await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'recipes', id));
        setMessage('レシピを削除しました。');
    };
    
    const handleRegisterPurchase = async (data) => {
        if (!user) return;
        const pData = { ...data, purchaseDate: Timestamp.fromDate(new Date(data.purchaseDate)), totalQuantity: parseFloat(data.totalQuantity), remainingQuantity: parseFloat(data.totalQuantity), unitPrice: parseFloat(data.unitPrice) };
        await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'purchases'), pData);
        setMessage('仕入れを登録しました。');
    };

    if (isLoading) return <div className="min-h-screen w-full flex items-center justify-center bg-gray-100 text-xl font-semibold">Loading System...</div>;
    if (error) return <div className="min-h-screen w-full flex items-center justify-center bg-red-100 text-red-800 p-4 font-bold">{String(error)}</div>;
    if (!isAppUnlocked) return <LoginScreen onUnlock={() => setIsAppUnlocked(true)} />;

    return (
        <div className="flex flex-col md:flex-row min-h-screen w-full bg-gray-100 font-sans">
            <SideBar view={view} setView={setView} />
            <MobileNav view={view} setView={setView} />
            <main className="flex-1 p-4 md:p-6 overflow-y-auto w-full">
                {view === 'itemMaster' && <ProductMaster products={products} onSave={handleSaveProduct} onDelete={handleDeleteProduct} />}
                {view === 'purchase' && <PurchaseRegistration products={products} onRegister={handleRegisterPurchase} setMessage={setMessage} />}
                {view === 'recipeMaster' && <RecipeMaster products={products} productMap={productMap} recipes={recipes} currentStock={currentStock} averageUnitCostMap={averageUnitCostMap} onSave={handleSaveRecipe} onDelete={handleDeleteRecipe} />}
                {view === 'salesList' && <SalesPriceList finalProductList={finalProductList} onUpdateSalePrice={handleUpdateSalePrice} />}
                {view === 'monthlyInventory' && <MonthlyInventory currentStock={currentStock} allPurchases={purchases} setMessage={setMessage} />}
                {view === 'orderRequest' && <OrderRequest products={products} setMessage={setMessage} />}
                {view === 'dashboard' && <Dashboard currentStock={currentStock} productMap={productMap} message={message} />}
            </main>
        </div>
    );
};

// --- 基本パーツ ---
const InputField = ({ id, label, type='text', value, onChange, placeholder }) => (
    <div className="flex flex-col"><label htmlFor={id} className="text-sm font-medium text-gray-600 mb-1">{label}</label><input id={id} type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className="p-3 border rounded-lg focus:ring-blue-500" /></div>
);
const SelectField = ({ id, label, value, onChange, options }) => (
    <div className="flex flex-col"><label htmlFor={id} className="text-sm font-medium text-gray-600 mb-1">{label}</label><select id={id} value={value} onChange={e=>onChange(e.target.value)} className="p-3 border rounded-lg bg-white">{options.map(o=><option key={o} value={o}>{o}</option>)}</select></div>
);
const Th = ({ children, className='' }) => <th className={`px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${className}`}>{children}</th>;
const Td = ({ children, className='' }) => <td className={`px-4 py-4 text-sm text-gray-800 ${className}`}>{children}</td>;

export default App;