# create release folder
mkdir -p build
rm -r build/*

# copy Jaeger CFN templates 
cp -R templates build
# copy CFN templates from submodules, keep folder structure
find submodules/*/templates -name '*.*' | cpio -pdm build
