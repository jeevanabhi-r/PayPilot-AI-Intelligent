export const catalog = [
  {id:'headphones',name:'Studio Wireless Headphones',category:'Electronics',price:79.99,emoji:'🎧',color:'#9b8cff',description:'Immersive sound · 32-hour battery'},
  {id:'keyboard',name:'Mechanical Keyboard Pro',category:'Electronics',price:119.00,emoji:'⌨️',color:'#50b9ef',description:'Low-profile keys · RGB backlight'},
  {id:'desk',name:'Minimal Desk Lamp',category:'Workspace',price:44.50,emoji:'💡',color:'#f0ae65',description:'Warm ambient light · USB-C'},
  {id:'backpack',name:'Everyday Tech Backpack',category:'Lifestyle',price:64.00,emoji:'🎒',color:'#78cfaa',description:'Weatherproof · Laptop sleeve'},
  {id:'mouse',name:'Precision Wireless Mouse',category:'Electronics',price:39.99,emoji:'🖱️',color:'#ec8ca5',description:'Silent clicks · Ergonomic'},
  {id:'stand',name:'Adjustable Laptop Stand',category:'Workspace',price:34.00,emoji:'💻',color:'#b7b5f4',description:'Aluminum · Height adjustable'}
];
export function parseRequest(message){
  const m=String(message||'').toLowerCase();
  const budgetMatch=m.match(/(?:under|below|budget(?: of)?|less than|within|up to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/);
  const budget=budgetMatch?Number(budgetMatch[1]):null;
  const matches=catalog.map(p=>({p,score:(p.name+' '+p.category+' '+p.description).toLowerCase().split(/\W+/).filter(w=>w.length>3&&m.includes(w)).length+(m.includes(p.id)?3:0)})).sort((a,b)=>b.score-a.score);
  let product=matches[0]?.score>0?matches[0].p:null;
  if(!product&&budget!==null) product=[...catalog].filter(p=>p.price<=budget).sort((a,b)=>b.price-a.price)[0]||null;
  if(!product)product=catalog[0];
  const alternatives=catalog.filter(p=>p.id!==product.id&&(budget===null||p.price<=budget)).slice(0,3);
  return {productId:product.id,budget,reason:`${product.name} is a relevant catalog option${budget!==null?` for your $${budget.toFixed(2)} budget`:''}. Review the product and price before checkout.`,alternatives:alternatives.map(p=>p.id)};
}
export function validatePlan(plan){return plan&&catalog.some(p=>p.id===plan.productId)?plan:null}

export function compareProducts(products, budget=null){
  const verified=products.filter(product=>Number.isFinite(product.price)&&product.currency&&product.name);
  return verified.map(product=>({...product,withinBudget:budget===null||product.price<=budget,budgetDifference:budget===null?null:Number((budget-product.price).toFixed(2))})).sort((a,b)=>a.price-b.price);
}
