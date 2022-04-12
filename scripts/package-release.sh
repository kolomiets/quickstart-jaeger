RELEASE_NAME="$1"

# create release folder
mkdir -p $RELEASE_NAME

# copy Jaeger CFN templates 
cp -R templates $RELEASE_NAME
# copy CFN templates from submodules, keep folder structure
find submodules/*/templates -name '*.*' | cpio -pdm $RELEASE_NAME
