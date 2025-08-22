import React from 'react';
import { ProductCard } from '../molecules/ProductCard';

export interface Product {
  id: string;
  name: string;
  price: number;
  imageUrl: string;
  stock: number;
}

interface ProductGridProps {
  products: Product[];
}

export const ProductGrid: React.FC<ProductGridProps> = ({ products }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          name={product.name}
          price={product.price}
          imageUrl={product.imageUrl}
          stock={product.stock}
        />
      ))}
    </div>
  );
};
