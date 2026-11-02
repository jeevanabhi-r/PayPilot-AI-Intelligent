import test from 'node:test';import assert from 'node:assert/strict';import {parseRequest,validatePlan,catalog,compareProducts} from './logic.js';
import {listMarketplaceProducts,getMarketplaceProduct} from './marketplace.js';
test('catalog contains valid USD prices',()=>assert.ok(catalog.every(p=>p.price>0&&p.id)));
test('extracts budget',()=>assert.equal(parseRequest('I need a mouse under $50').budget,50));
test('recognizes product',()=>assert.equal(parseRequest('I need a keyboard').productId,'keyboard'));
test('rejects unknown plan',()=>assert.equal(validatePlan({productId:'not-real'}),null));
test('comparison computes budget fit without inventing values',()=>{const result=compareProducts([{name:'A',price:40,currency:'USD'},{name:'B',price:80,currency:'USD'}],50);assert.equal(result[0].withinBudget,true);assert.equal(result[1].budgetDifference,-30)});
test('marketplace fallback keeps catalog products checkout-eligible',async()=>{const products=await listMarketplaceProducts(null);assert.ok(products.every(product=>product.available&&product.currency==='USD'));assert.equal((await getMarketplaceProduct(null,'keyboard')).price,119)});
