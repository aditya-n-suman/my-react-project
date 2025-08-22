import React from 'react';
import { Input } from '../atoms/Input';
import { ProductGrid, type Product } from '../organisms/ProductGrid';

interface ProductInventoryTemplateProps {
  products: Product[];
  onSearch: (term: string) => void;
}

export const ProductInventoryTemplate: React.FC<ProductInventoryTemplateProps> = ({
  products,
  onSearch,
}) => {
  return (
    <div className="container mx-auto px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-4">Product Inventory</h1>
        <Input
          type="search"
          placeholder="Search products..."
          onChange={(e) => onSearch(e.target.value)}
          className="max-w-md"
        />
      </header>
      <main>
        <ProductGrid products={products} />
      </main>
    </div>
  );
};
