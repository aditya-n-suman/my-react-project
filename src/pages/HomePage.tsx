import React, { useState } from 'react';
import { ProductInventoryTemplate } from '../components/templates/ProductInventoryTemplate';

const SAMPLE_PRODUCTS = [
  {
    id: '1',
    name: 'Sample Product 1',
    price: 99.99,
    imageUrl: 'https://via.placeholder.com/300',
    stock: 10
  },
  // Add more sample products as needed
];

export const HomePage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [products] = useState(SAMPLE_PRODUCTS);

  const filteredProducts = products.filter(product =>
    product.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <ProductInventoryTemplate
      products={filteredProducts}
      onSearch={setSearchTerm}
    />
  );
};
