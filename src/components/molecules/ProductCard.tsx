import React from 'react';
import { Button } from '../atoms/Button';

interface ProductCardProps {
  name: string;
  price: number;
  imageUrl: string;
  stock: number;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  name,
  price,
  imageUrl,
  stock
}) => {
  return (
    <div className="border rounded-lg p-4 shadow-sm">
      <img src={imageUrl} alt={name} className="w-full h-48 object-cover rounded-md" />
      <h3 className="mt-2 text-lg font-semibold">{name}</h3>
      <p className="text-gray-600">${price.toFixed(2)}</p>
      <p className="text-sm text-gray-500">In stock: {stock}</p>
      <Button variant="primary" className="mt-2 w-full">
        Add to Cart
      </Button>
    </div>
  );
};
